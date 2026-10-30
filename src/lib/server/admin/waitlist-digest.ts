import { and, eq, inArray } from 'drizzle-orm';
import type { createDb } from '#lib/server/db/index.js';
import { notificationLog, users } from '#lib/server/db/schema.js';
import { createEmailSender } from '#lib/server/email/index.js';
import { renderWaitlistDigestEmail } from '#lib/server/email/templates.js';

type Db = ReturnType<typeof createDb>;

/** Keyed per admin *and* per waiting account, so a new signup produces a new digest but a known one never repeats. */
function logId(adminId: string, pendingId: string): string {
	return `waitlist:${adminId}:${pendingId}`;
}

export interface WaitlistDigestResult {
	admins: number;
	sent: number;
	skipped: number;
	pending: number;
}

export async function sendWaitlistDigest(
	db: Db,
	env: Env,
	now = new Date()
): Promise<WaitlistDigestResult> {
	const pending = await db
		.select({ id: users.id, email: users.email, createdAt: users.createdAt })
		.from(users)
		.where(eq(users.status, 'pending'));

	if (pending.length === 0) return { admins: 0, sent: 0, skipped: 0, pending: 0 };

	const admins = await db
		.select({ id: users.id, email: users.email })
		.from(users)
		.where(and(eq(users.role, 'admin'), eq(users.status, 'enabled')));

	const sender = createEmailSender(env);
	let sent = 0;
	let skipped = 0;

	for (const admin of admins) {
		const candidateIds = pending.map((entry) => logId(admin.id, entry.id));
		const logged = await db
			.select({ id: notificationLog.id })
			.from(notificationLog)
			.where(inArray(notificationLog.id, candidateIds));
		const seen = new Set(logged.map((row) => row.id));
		const fresh = pending.filter((entry) => !seen.has(logId(admin.id, entry.id)));

		if (fresh.length === 0) {
			skipped += 1;
			continue;
		}

		await sender.send({
			to: admin.email,
			subject:
				fresh.length === 1
					? '1 account waiting for access'
					: `${fresh.length} accounts waiting for access`,
			html: renderWaitlistDigestEmail(
				fresh.map((entry) => ({
					email: entry.email,
					signedUpAt: entry.createdAt.toISOString().slice(0, 10)
				}))
			)
		});

		await db
			.insert(notificationLog)
			.values(
				fresh.map((entry) => ({ id: logId(admin.id, entry.id), userId: admin.id, sentAt: now }))
			);
		sent += 1;
	}

	return { admins: admins.length, sent, skipped, pending: pending.length };
}
