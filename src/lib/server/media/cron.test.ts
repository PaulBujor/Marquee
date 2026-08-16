import { describe, expect, it } from 'vitest';
import { createTestDb } from '$lib/server/db/test-db';
import { media } from '$lib/server/db/schema';
import { mediaId } from '$lib/sync/events';
import { createMemoryQueue } from '$lib/server/queue/memory';
import { ENQUEUE_MAX, enqueueStaleMedia } from './cron';
import type { MediaRefreshMessage } from './refresh-consumer';

const T0 = Date.UTC(2026, 6, 24);

/** Insert a bare media row (refreshedAt 0 ⇒ always considered stale). */
async function seedMedia(
	db: ReturnType<typeof createTestDb>,
	externalId: string,
	over: {
		type: 'movie' | 'show';
		inProduction?: boolean | null;
		releaseDate?: string | null;
		status?: string | null;
	}
) {
	await db.insert(media).values({
		id: mediaId('tmdb', externalId),
		provider: 'tmdb',
		externalId,
		source: 'linked',
		type: over.type,
		title: externalId,
		inProduction: over.inProduction ?? null,
		releaseDate: over.releaseDate ?? null,
		status: over.status ?? null,
		version: 1,
		refreshedAt: 0
	});
}

describe('enqueueStaleMedia', () => {
	it('enqueues in-production shows + unreleased movies (skips finished shows + released movies)', async () => {
		const db = createTestDb();
		await seedMedia(db, 'show/1', { type: 'show', inProduction: true });
		await seedMedia(db, 'show/2', { type: 'show', inProduction: false }); // finished → skip
		await seedMedia(db, 'movie/3', { type: 'movie', releaseDate: null }); // undated → unreleased
		await seedMedia(db, 'movie/4', { type: 'movie', releaseDate: '2027-01-01' }); // future → unreleased
		await seedMedia(db, 'movie/5', { type: 'movie', releaseDate: '2020-01-01' }); // released → skip

		const queue = createMemoryQueue<MediaRefreshMessage>();
		const result = await enqueueStaleMedia(db, queue, T0);

		// show/1 + movie/3 + movie/4 are unsettled; show/2 + movie/5 are settled.
		expect(result).toEqual({ scanned: 3, queued: 3, capped: false });
		expect(queue.items).toHaveLength(3);
		expect(queue.items.map((m) => m.externalId).sort()).toEqual(['movie/3', 'movie/4', 'show/1']);
		expect(queue.items.every((m) => m.provider === 'tmdb' && m.force === undefined)).toBe(true);
	});

	it('returns zeroes and enqueues nothing when nothing is unsettled', async () => {
		const db = createTestDb();
		await seedMedia(db, 'show/8', { type: 'show', inProduction: false });
		await seedMedia(db, 'movie/9', { type: 'movie', releaseDate: '2020-01-01' });
		const queue = createMemoryQueue<MediaRefreshMessage>();

		expect(await enqueueStaleMedia(db, queue, T0)).toEqual({
			scanned: 0,
			queued: 0,
			capped: false
		});
		expect(queue.items).toEqual([]);
	});

	it('sweeps a between-seasons show — in_production false but an airing status', async () => {
		const db = createTestDb();
		// The case `needsRefresh` covers via AIRING_STATUSES; the sweep has to match the same rule.
		await seedMedia(db, 'show/42', {
			type: 'show',
			inProduction: false,
			status: 'Returning Series'
		});
		const queue = createMemoryQueue<MediaRefreshMessage>();
		const result = await enqueueStaleMedia(db, queue, T0);
		expect(result.scanned).toBe(1);
		expect(result.queued).toBe(1);
	});

	it('counts a show matching both show branches once', async () => {
		const db = createTestDb();
		await seedMedia(db, 'show/43', {
			type: 'show',
			inProduction: true,
			status: 'Returning Series'
		});
		const queue = createMemoryQueue<MediaRefreshMessage>();
		const result = await enqueueStaleMedia(db, queue, T0);
		expect(result.scanned).toBe(1);
		expect(result.queued).toBe(1);
		expect(queue.items).toHaveLength(1);
	});

	// Exercised against an injected cap rather than ENQUEUE_MAX: the behaviour under test is the
	// boundary itself, and seeding 5000+ rows to prove it costs seconds and grows with the ceiling.
	it('caps a run at the enqueue ceiling and reports the overflow', async () => {
		const db = createTestDb();
		for (let i = 0; i < 7; i++) {
			await seedMedia(db, `show/${1000 + i}`, { type: 'show', inProduction: true });
		}
		const queue = createMemoryQueue<MediaRefreshMessage>();
		const result = await enqueueStaleMedia(db, queue, T0, false, 5);
		expect(result.queued).toBe(5);
		expect(result.capped).toBe(true);
		expect(queue.items).toHaveLength(5);
		// The per-branch read stops at `max + 1`, so `scanned` proves overflow without being the
		// full population count.
		expect(result.scanned).toBe(6);
	});

	it('defaults the ceiling to ENQUEUE_MAX', async () => {
		const db = createTestDb();
		await seedMedia(db, 'show/1', { type: 'show', inProduction: true });
		const queue = createMemoryQueue<MediaRefreshMessage>();
		const result = await enqueueStaleMedia(db, queue, T0);
		expect(ENQUEUE_MAX).toBe(5000);
		expect(result.capped).toBe(false);
		expect(result.queued).toBe(1);
	});

	it('carries force through to every enqueued message', async () => {
		const db = createTestDb();
		await seedMedia(db, 'show/50', { type: 'show', inProduction: true });
		const queue = createMemoryQueue<MediaRefreshMessage>();

		await enqueueStaleMedia(db, queue, T0, true);

		expect(queue.items).toEqual([{ provider: 'tmdb', externalId: 'show/50', force: true }]);
	});
});
