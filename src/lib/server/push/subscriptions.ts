import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { pushSubscriptions } from '$lib/server/db/schema';
import type { createDb } from '$lib/server/db';

type Db = ReturnType<typeof createDb>;

/**
 * Body of `POST /api/push/subscribe` — the browser `PushSubscription.toJSON()` shape plus the
 * device identity/label and the client-detected timezone. Re-validated server-side (the client is
 * never trusted); `endpoint` must be an https push-service URL.
 */
export const pushSubscribeSchema = z.object({
	endpoint: z
		.string()
		.min(1)
		.max(2048)
		.refine((s) => s.startsWith('https://'), 'endpoint must be an https URL'),
	keys: z.object({
		p256dh: z.string().min(1).max(256),
		auth: z.string().min(1).max(256)
	}),
	deviceId: z.string().min(1).max(128),
	deviceLabel: z.string().max(120).optional(),
	// IANA timezone (e.g. `Europe/Madrid`); loosely bounded, resolved at send time.
	timezone: z.string().max(64).optional()
});

export type PushSubscribeInput = z.infer<typeof pushSubscribeSchema>;

/**
 * Store (or refresh) a push subscription for a user, keyed by its `endpoint`. Re-subscribing from
 * the same device is idempotent: the row is updated in place (keys can rotate, timezone can change)
 * and `lastUsedAt` bumped, rather than creating duplicates.
 */
export async function upsertSubscription(
	db: Db,
	userId: string,
	input: PushSubscribeInput,
	now: Date = new Date()
): Promise<void> {
	await db
		.insert(pushSubscriptions)
		.values({
			userId,
			endpoint: input.endpoint,
			p256dh: input.keys.p256dh,
			auth: input.keys.auth,
			deviceId: input.deviceId,
			deviceLabel: input.deviceLabel ?? null,
			timezone: input.timezone ?? null,
			createdAt: now,
			lastUsedAt: now
		})
		.onConflictDoUpdate({
			target: pushSubscriptions.endpoint,
			set: {
				userId,
				p256dh: input.keys.p256dh,
				auth: input.keys.auth,
				deviceId: input.deviceId,
				deviceLabel: input.deviceLabel ?? null,
				timezone: input.timezone ?? null,
				lastUsedAt: now
			}
		});
}

/**
 * Delete one of the user's own subscriptions by id. Scoped to `userId` so a caller can never remove
 * another account's device. Returns true when a row was actually removed.
 */
export async function deleteSubscription(db: Db, userId: string, id: string): Promise<boolean> {
	const deleted = await db
		.delete(pushSubscriptions)
		.where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId)))
		.returning({ id: pushSubscriptions.id });
	return deleted.length > 0;
}
