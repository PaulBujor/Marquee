/** The only way a provider id becomes our media id: a stored alias, never a derivation. */
import { and, eq } from 'drizzle-orm';
import { mediaExternalIds } from '#lib/server/db/schema.js';
import type { createDb } from '#lib/server/db/index.js';
import type { ExternalIdProvider } from '#lib/sync/events.js';

type Db = ReturnType<typeof createDb>;

/**
 * The media id a stored alias names, or null when no alias does.
 *
 * A miss is a miss: this never falls back to the id `(provider, externalId)` would derive to. A
 * derived id is a title nobody has stored, and a caller that treated it as one would report
 * success for a title it never hydrated.
 */
export async function resolveMediaId(
	db: Db,
	provider: ExternalIdProvider,
	externalId: string
): Promise<string | null> {
	const [row] = await db
		.select({ mediaId: mediaExternalIds.mediaId })
		.from(mediaExternalIds)
		.where(
			and(eq(mediaExternalIds.provider, provider), eq(mediaExternalIds.externalId, externalId))
		)
		.limit(1);
	return row?.mediaId ?? null;
}

/**
 * Records that `mediaId` is known by `(provider, externalId)`.
 *
 * An alias that already exists is left untouched rather than updated — aliases are append-only, so
 * a write can never take an external id away from the title a link gave it to, and re-running a
 * backfill is a no-op. A conflicting `(provider, external_id)` is tolerated by that same rule, not
 * by the caller checking first.
 */
export async function writeExternalId(
	db: Db,
	mediaId: string,
	provider: ExternalIdProvider,
	externalId: string
): Promise<void> {
	await db.insert(mediaExternalIds).values({ mediaId, provider, externalId }).onConflictDoNothing();
}
