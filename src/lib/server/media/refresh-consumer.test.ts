import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '$lib/server/db/test-db';
import { media } from '$lib/server/db/schema';
import { mediaId } from '$lib/sync/events';
import type { MediaDetail, SeasonDetail } from '$lib/server/tmdb';
import type { QueueEnvelope } from '$lib/server/queue/types';
import {
	MAX_DELIVERY_ATTEMPTS,
	processMediaRefreshBatch,
	type MediaRefreshMessage
} from './refresh-consumer';

const T0 = Date.UTC(2026, 6, 24);

const SHOW_DETAIL: MediaDetail = {
	tmdbId: 1,
	type: 'show',
	title: 'title-1',
	year: 2026,
	overview: '',
	posterPath: null,
	backdropPath: null,
	rating: null,
	voteCount: 0,
	runtime: null,
	genres: [],
	cast: [],
	director: null,
	writers: [],
	producers: [],
	creators: [],
	trailer: null,
	releaseDate: null,
	status: 'Returning Series',
	inProduction: true,
	firstAirDate: '2026-01-01',
	lastAirDate: '2026-07-01',
	seasons: [
		{
			seasonNumber: 1,
			name: 'S1',
			episodeCount: 1,
			airDate: '2026-01-01',
			posterPath: null,
			overview: ''
		}
	],
	similar: []
};

function seasonDetail(seasonNumber: number): SeasonDetail {
	return {
		seasonNumber,
		name: `S${seasonNumber}`,
		episodes: [
			{
				episodeNumber: 1,
				name: 'E1',
				airDate: '2026-01-01',
				overview: '',
				stillPath: null,
				runtime: 42
			}
		]
	};
}

/** A stub that always succeeds. */
function workingTmdb() {
	return {
		async getDetails(): Promise<MediaDetail> {
			return SHOW_DETAIL;
		},
		async getSeason(_id: number, seasonNumber: number): Promise<SeasonDetail> {
			return seasonDetail(seasonNumber);
		}
	};
}

/** A stub whose season fetch always fails, so `refreshMedia` rethrows (see hydrate.ts). */
function failingTmdb() {
	return {
		async getDetails(): Promise<MediaDetail> {
			return SHOW_DETAIL;
		},
		async getSeason(): Promise<SeasonDetail> {
			throw new Error('tmdb season fetch failed');
		}
	};
}

async function seedMedia(db: ReturnType<typeof createTestDb>, externalId: string) {
	await db.insert(media).values({
		id: mediaId('tmdb', externalId),
		provider: 'tmdb',
		externalId,
		source: 'linked',
		type: 'show',
		title: externalId,
		inProduction: true,
		version: 1,
		refreshedAt: 0
	});
}

function envelope(externalId: string, attempts: number): QueueEnvelope<MediaRefreshMessage> {
	return { body: { provider: 'tmdb', externalId }, attempts };
}

describe('processMediaRefreshBatch', () => {
	it('acks a title that refreshes successfully', async () => {
		const db = createTestDb();
		await seedMedia(db, 'show/1');

		const outcomes = await processMediaRefreshBatch(db, workingTmdb(), [envelope('show/1', 1)], T0);

		expect(outcomes).toEqual(['ack']);
		const [row] = await db
			.select()
			.from(media)
			.where(eq(media.id, mediaId('tmdb', 'show/1')));
		expect(row.refreshedAt).toBe(T0);
	});

	it('retries a failing title while under the attempt cap', async () => {
		const db = createTestDb();
		await seedMedia(db, 'show/2');

		const outcomes = await processMediaRefreshBatch(
			db,
			failingTmdb(),
			[envelope('show/2', MAX_DELIVERY_ATTEMPTS - 1)],
			T0
		);

		expect(outcomes).toEqual(['retry']);
	});

	it('gives up (acks) a failing title once the attempt cap is reached', async () => {
		const db = createTestDb();
		await seedMedia(db, 'show/3');

		const outcomes = await processMediaRefreshBatch(
			db,
			failingTmdb(),
			[envelope('show/3', MAX_DELIVERY_ATTEMPTS)],
			T0
		);

		expect(outcomes).toEqual(['ack']);
	});

	it('processes a mixed batch independently, in order', async () => {
		const db = createTestDb();
		await seedMedia(db, 'show/4');
		await seedMedia(db, 'show/5');

		const outcomes = await processMediaRefreshBatch(
			db,
			failingTmdb(),
			[envelope('show/4', 1), envelope('show/5', MAX_DELIVERY_ATTEMPTS)],
			T0
		);

		expect(outcomes).toEqual(['retry', 'ack']);
	});

	it('carries the force flag through to refreshMedia, bypassing the TTL', async () => {
		const db = createTestDb();
		await db.insert(media).values({
			id: mediaId('tmdb', 'show/6'),
			provider: 'tmdb',
			externalId: 'show/6',
			source: 'linked',
			type: 'show',
			title: 'show/6',
			inProduction: true,
			version: 1,
			// A fresh refreshedAt (== now) would normally skip re-hydration; force bypasses that.
			refreshedAt: T0
		});
		const tmdb = workingTmdb();
		let detailCalls = 0;
		const spied = {
			...tmdb,
			getDetails: async (...args: Parameters<typeof tmdb.getDetails>) => {
				detailCalls++;
				return tmdb.getDetails(...args);
			}
		};

		const outcomes = await processMediaRefreshBatch(
			db,
			spied,
			[{ body: { provider: 'tmdb', externalId: 'show/6', force: true }, attempts: 1 }],
			T0
		);

		expect(outcomes).toEqual(['ack']);
		expect(detailCalls).toBe(1);
	});
});
