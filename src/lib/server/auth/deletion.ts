import { and, eq, inArray } from 'drizzle-orm';
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

export type DeleteRefusal = 'self' | 'not-found' | 'last-admin';

export const DELETE_REFUSALS: Record<DeleteRefusal, string> = {
	self: "You can't delete your own account here — use Settings.",
	'not-found': 'That account no longer exists.',
	'last-admin': 'This is the last admin — promote someone else first.'
};

/**
 * Every row a user owns, children before parents. Seasons and episodes are keyed by `media_id`, so
 * deleting the media the user owns takes them and its credits with it; catalog rows nobody owns stay.
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

/**
 * Writes the audit row first: `admin_audit` carries no foreign key, so it has to outlive the account
 * the cascade is about to remove.
 */
export async function deleteUser(
	db: Db,
	actor: Actor,
	targetId: string,
	ip?: string | null
): Promise<{ ok: true; email: string } | { ok: false; refusal: DeleteRefusal }> {
	if (actor.id === targetId) return { ok: false, refusal: 'self' };

	const [target] = await db
		.select({ id: users.id, email: users.email, role: users.role })
		.from(users)
		.where(eq(users.id, targetId))
		.limit(1);

	if (!target) return { ok: false, refusal: 'not-found' };

	if (target.role === 'admin') {
		const admins = await db
			.select({ id: users.id })
			.from(users)
			.where(and(eq(users.role, 'admin'), eq(users.status, 'enabled')));
		if (admins.length <= 1) return { ok: false, refusal: 'last-admin' };
	}

	await auditStatement(db, {
		actor,
		action: 'user.purge',
		target: { type: 'user', id: target.id, label: target.email },
		ip
	});
	await deleteUserCascade(db, target);

	return { ok: true, email: target.email };
}
