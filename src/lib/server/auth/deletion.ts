import { and, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import type { createDb } from '#lib/server/db/index.js';
import {
	credits,
	emailChangeTokens,
	episodeWatches,
	episodes,
	events,
	loginTokens,
	media,
	notificationLog,
	people,
	pushSubscriptions,
	seasons,
	sessions,
	sharePreviewWarms,
	syncState,
	tracking,
	users,
	type User
} from '#lib/server/db/schema.js';
import { auditStatement } from '#lib/server/admin/audit.js';

type Db = ReturnType<typeof createDb>;

type Actor = { id: string; email: string };

/** Long enough to undo a mistake, short enough that the account is really gone afterwards. */
export const DELETION_GRACE_DAYS = 30;

export type DeleteRefusal = 'self' | 'not-found' | 'already-deleted' | 'last-admin';

export const DELETE_REFUSALS: Record<DeleteRefusal, string> = {
	self: "You can't delete your own account here — use Settings.",
	'not-found': 'That account no longer exists.',
	'already-deleted': 'That account is already marked for deletion.',
	'last-admin': 'This is the last admin — promote someone else first.'
};

/**
 * Every row a user owns, children before parents, in one batch. Media the user owns takes its seasons,
 * episodes and credits with it; shared catalog rows (a `media` row nobody owns) stay.
 */
export async function deleteUserCascade(db: Db, user: Pick<User, 'id' | 'email'>): Promise<void> {
	const mediaIds = (
		await db.select({ id: media.id }).from(media).where(eq(media.ownerUserId, user.id))
	).map((row) => row.id);

	const statements = [];
	if (mediaIds.length) {
		statements.push(
			db.delete(credits).where(inArray(credits.mediaId, mediaIds)),
			db.delete(episodes).where(inArray(episodes.mediaId, mediaIds)),
			db.delete(seasons).where(inArray(seasons.mediaId, mediaIds))
		);
	}

	statements.push(
		db.delete(emailChangeTokens).where(eq(emailChangeTokens.userId, user.id)),
		db.delete(sessions).where(eq(sessions.userId, user.id)),
		db.delete(loginTokens).where(eq(loginTokens.email, user.email)),
		db.delete(events).where(eq(events.userId, user.id)),
		db.delete(syncState).where(eq(syncState.userId, user.id)),
		db.delete(tracking).where(eq(tracking.userId, user.id)),
		db.delete(episodeWatches).where(eq(episodeWatches.userId, user.id)),
		db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, user.id)),
		db.delete(notificationLog).where(eq(notificationLog.userId, user.id)),
		db.delete(sharePreviewWarms).where(eq(sharePreviewWarms.userId, user.id)),
		db.delete(media).where(eq(media.ownerUserId, user.id)),
		db.delete(people).where(eq(people.ownerUserId, user.id)),
		db.delete(users).where(eq(users.id, user.id))
	);

	await db.batch(statements as [never, ...never[]]);
}

export async function softDeleteUser(
	db: Db,
	actor: Actor,
	targetId: string,
	ip?: string | null
): Promise<{ ok: true; email: string } | { ok: false; refusal: DeleteRefusal }> {
	if (actor.id === targetId) return { ok: false, refusal: 'self' };

	const [target] = await db
		.select({ id: users.id, email: users.email, role: users.role, deletedAt: users.deletedAt })
		.from(users)
		.where(eq(users.id, targetId))
		.limit(1);

	if (!target) return { ok: false, refusal: 'not-found' };
	if (target.deletedAt) return { ok: false, refusal: 'already-deleted' };

	if (target.role === 'admin') {
		const admins = await db
			.select({ id: users.id })
			.from(users)
			.where(and(eq(users.role, 'admin'), eq(users.status, 'enabled')));
		if (admins.length <= 1) return { ok: false, refusal: 'last-admin' };
	}

	await db.batch([
		db
			.update(users)
			.set({ deletedAt: new Date(), updatedAt: new Date() })
			.where(eq(users.id, targetId)),
		db.delete(sessions).where(eq(sessions.userId, targetId)),
		auditStatement(db, {
			actor,
			action: 'user.delete',
			target: { type: 'user', id: target.id, label: target.email },
			ip
		})
	]);

	return { ok: true, email: target.email };
}

/**
 * Runs the cascade for accounts whose grace period has elapsed. Each audit row is written before its
 * cascade, because `admin_audit` carries no foreign key and must outlive the account.
 */
export async function purgeDueUsers(db: Db, now = new Date()): Promise<number> {
	const cutoff = new Date(now.getTime() - DELETION_GRACE_DAYS * 86_400_000);

	const due = await db
		.select({ id: users.id, email: users.email })
		.from(users)
		.where(and(isNotNull(users.deletedAt), lte(users.deletedAt, cutoff)));

	for (const user of due) {
		await auditStatement(db, {
			actor: { id: 'system', email: 'purge-cron' },
			action: 'user.purge',
			target: { type: 'user', id: user.id, label: user.email },
			reason: `grace period of ${DELETION_GRACE_DAYS} days elapsed`
		});
		await deleteUserCascade(db, user);
	}

	return due.length;
}
