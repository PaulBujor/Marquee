import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEventToIdb, applyEventsToIdb } from '$lib/client/idb';
import { createEvent, mediaId, type EventEnvelope, type MediaRecord } from '$lib/sync/events';
import { openDb, setActiveUser } from '$lib/client/idb/db';
import { getEpisodes, getMedia, putMedia } from '$lib/client/idb/media';
import { reportClientError } from '$lib/client/report-error';
import {
	MEDIA_SYNC_MAX,
	type MediaSyncRequest,
	type MediaSyncResponse
} from '$lib/sync/media-protocol';
import { MAX_DRAIN_ITERATIONS, runMediaSync } from './media-sync';

vi.mock('$lib/client/report-error', () => ({ reportClientError: vi.fn() }));

setActiveUser('media-sync-test');

// fake-indexeddb persists across a file's tests; isolate each test's `tracking`/`episodeWatches`/
// `media` rows rather than accumulating across them (the bulk tests below seed hundreds of rows).
beforeEach(async () => {
	const db = await openDb();
	await db.clear('tracking');
	await db.clear('episodeWatches');
	await db.clear('media');
	await db.clear('seasons');
	await db.clear('episodes');
});

const DEVICE = '11111111-1111-1111-1111-111111111111';

/** Seed a local `tracking` row for `externalId`, the way a real `tracking.added` event would. */
async function track(externalId: string): Promise<void> {
	await applyEventToIdb(trackEvent(externalId));
}

function trackEvent(externalId: string): EventEnvelope<'tracking.added'> {
	return createEvent(
		'tracking.added',
		mediaId('tmdb', externalId),
		{ status: 'want_to_watch' },
		DEVICE
	);
}

/** Seed `count` local `tracking` rows in one batch (an import-sized backlog would be slow one at a time).
 *  Returns the raw external ids — pass these to `record()`; use `mediaId('tmdb', id)` to get the hashed id. */
async function trackMany(count: number, prefix: string): Promise<string[]> {
	const externalIds = Array.from({ length: count }, (_, i) => `${prefix}/${i}`);
	await applyEventsToIdb(externalIds.map(trackEvent));
	return externalIds;
}

function record(externalId: string, over: Partial<MediaRecord> = {}): MediaRecord {
	return {
		id: mediaId('tmdb', externalId),
		provider: 'tmdb',
		externalId,
		source: 'linked',
		type: 'movie',
		title: `title-${externalId}`,
		year: 1999,
		posterPath: '/p.jpg',
		backdropPath: '/b.jpg',
		overview: '',
		genres: [],
		releaseDate: '1999-03-31',
		status: null,
		inProduction: null,
		firstAirDate: null,
		lastAirDate: null,
		version: 1,
		seasons: null,
		episodes: null,
		...over
	};
}

/** A fetch stub that captures the request body and returns the given media list. */
function stubFetch(media: MediaRecord[], sent: MediaSyncRequest[]) {
	return (async (_url: string, init: RequestInit) => {
		sent.push(JSON.parse(init.body as string) as MediaSyncRequest);
		return new Response(JSON.stringify({ media }), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	}) as unknown as typeof fetch;
}

/** A fetch stub that returns a queued sequence of responses (defaulting to the last one). */
function stubResponses(responses: MediaSyncResponse[], sent: MediaSyncRequest[]) {
	let i = 0;
	return (async (_url: string, init: RequestInit) => {
		sent.push(JSON.parse(init.body as string) as MediaSyncRequest);
		const body = responses[Math.min(i, responses.length - 1)];
		i++;
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	}) as unknown as typeof fetch;
}

/** A fetch stub that always reports the request current (nothing missing/behind, never pending). */
function stubCaughtUp(sent: MediaSyncRequest[]) {
	return stubFetch([], sent);
}

/** Every id sent across the requests' `have` entries, deduped. */
function haveIdsSent(sent: MediaSyncRequest[]): Set<string> {
	return new Set(sent.flatMap((req) => req.have.map((h) => h.id)));
}

describe('runMediaSync', () => {
	it('makes no request when nothing is tracked', async () => {
		const sent: MediaSyncRequest[] = [];
		const result = await runMediaSync({ fullCheck: true }, stubFetch([], sent));
		expect(sent).toHaveLength(0);
		expect(result).toEqual({ applied: 0, truncated: false });
	});

	it('light pass: makes no request when every tracked title already has a synced copy', async () => {
		await track('movie/1');
		await putMedia(record('movie/1', { version: 1 })); // already synced (version > 0)
		const sent: MediaSyncRequest[] = [];
		const result = await runMediaSync({ fullCheck: false }, stubFetch([], sent));
		expect(sent).toHaveLength(0);
		expect(result).toEqual({ applied: 0, truncated: false });
	});

	it('light pass: asks about a tracked title with no synced copy yet', async () => {
		const mid = mediaId('tmdb', 'movie/603');
		await track('movie/603');
		await putMedia(record('movie/603', { version: 0 })); // quick-add snapshot, not yet synced

		const sent: MediaSyncRequest[] = [];
		const result = await runMediaSync(
			{ fullCheck: false },
			stubFetch([record('movie/603', { version: 2, title: 'updated' })], sent)
		);

		expect(sent[0].have).toContainEqual({ id: mid, version: 0 });
		expect(sent[0].refs).toContainEqual({ provider: 'tmdb', externalId: 'movie/603' });
		expect(await getMedia(mid)).toMatchObject({ id: mid, title: 'updated', version: 2 });
		expect(result.applied).toBe(1);
	});

	it("full pass: reports every tracked title's version, even ones already synced", async () => {
		const mid = mediaId('tmdb', 'movie/778');
		await track('movie/778');
		await putMedia(record('movie/778', { version: 1 }));

		const sent: MediaSyncRequest[] = [];
		await runMediaSync({ fullCheck: true }, stubFetch([], sent));
		expect(sent[0].have).toContainEqual({ id: mid, version: 1 });
		expect(sent[0].refs).toContainEqual({ provider: 'tmdb', externalId: 'movie/778' });
	});

	it('fans a returned show record out into the seasons/episodes stores', async () => {
		const showId = mediaId('tmdb', 'show/1396');
		await track('show/1396');
		const show = record('show/1396', {
			id: showId,
			type: 'show',
			version: 3,
			seasons: [
				{
					seasonNumber: 1,
					name: 'S1',
					overview: '',
					airDate: '2008-01-20',
					posterPath: null,
					episodeCount: 2
				}
			],
			episodes: [
				{
					season: 1,
					episode: 1,
					name: 'Pilot',
					overview: '',
					airDate: '2008-01-20',
					runtime: 58,
					stillPath: null
				},
				{
					season: 1,
					episode: 2,
					name: 'Cat',
					overview: '',
					airDate: '2008-01-27',
					runtime: 48,
					stillPath: null
				}
			]
		});
		const sent: MediaSyncRequest[] = [];
		await runMediaSync({ fullCheck: true }, stubFetch([show], sent));

		expect(await getMedia(showId)).toMatchObject({ id: showId, type: 'show', version: 3 });
		const eps = await getEpisodes(showId);
		expect(eps.map((e) => [e.season, e.episode, e.airDate])).toEqual([
			[1, 1, '2008-01-20'],
			[1, 2, '2008-01-27']
		]);
	});

	it('loops until the server stops flagging `pending`, accumulating applied', async () => {
		await track('movie/loop-a');
		const sent: MediaSyncRequest[] = [];
		const result = await runMediaSync(
			{ fullCheck: true },
			stubResponses(
				[
					{ media: [record('movie/1')], pending: true },
					{ media: [record('movie/2')], pending: true },
					{ media: [record('movie/3')], pending: false }
				],
				sent
			)
		);
		expect(sent).toHaveLength(3); // drained across three passes
		expect(result).toEqual({ applied: 3, truncated: false });
	});

	it('bounds the drain loop when the server never clears `pending`, and reports the leftover', async () => {
		vi.mocked(reportClientError).mockClear();
		await track('movie/loop-b');
		const sent: MediaSyncRequest[] = [];
		const result = await runMediaSync(
			{ fullCheck: true },
			stubResponses([{ media: [], pending: true }], sent)
		);
		expect(sent).toHaveLength(MAX_DRAIN_ITERATIONS); // capped, not infinite
		expect(result.truncated).toBe(true);
		expect(reportClientError).toHaveBeenCalledWith(
			expect.objectContaining({ source: 'media-sync-truncated' })
		);
	});

	it('full pass over a library past MEDIA_SYNC_MAX reaches every title in one call — none silently excluded', async () => {
		const total = MEDIA_SYNC_MAX + 150; // 650: two chunks, well past the old single-slice ceiling
		const externalIds = await trackMany(total, 'movie-bulk');
		for (const externalId of externalIds) await putMedia(record(externalId, { version: 1 }));

		const sent: MediaSyncRequest[] = [];
		const result = await runMediaSync({ fullCheck: true }, stubCaughtUp(sent));

		expect(sent).toHaveLength(Math.ceil(total / MEDIA_SYNC_MAX)); // one request per chunk
		expect(sent.every((req) => req.have.length <= MEDIA_SYNC_MAX)).toBe(true); // wire cap intact
		expect(haveIdsSent(sent)).toEqual(new Set(externalIds.map((e) => mediaId('tmdb', e)))); // none dropped
		expect(result.truncated).toBe(false);
	});

	it('a chunk needing repeated hydration does not block an unvisited chunk behind it', async () => {
		const total = MEDIA_SYNC_MAX + 100; // two chunks: 500 + 100, both fully missing (need hydration)
		await trackMany(total, 'movie-hydrate');

		const sent: MediaSyncRequest[] = [];
		let calls = 0;
		const fetchFn = (async (_url: string, init: RequestInit) => {
			const body = JSON.parse(init.body as string) as MediaSyncRequest;
			sent.push(body);
			calls++;
			// The first chunk seen (500 ids) reports pending once, then clears. Any other chunk
			// (the 100-id remainder) clears immediately.
			const pending = body.have.length === MEDIA_SYNC_MAX && calls === 1;
			return new Response(JSON.stringify({ media: [], pending }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}) as unknown as typeof fetch;

		const result = await runMediaSync({ fullCheck: true }, fetchFn);

		expect(sent).toHaveLength(3); // 500-chunk, 100-chunk, then the requeued 500-chunk retry
		expect(sent[1].have).toHaveLength(100); // the smaller chunk was visited before the retry
		// The retry (request 3) is the same 500-chunk as request 1, not some other/partial set.
		expect(new Set(sent[2].have.map((h) => h.id))).toEqual(new Set(sent[0].have.map((h) => h.id)));
		expect(result.truncated).toBe(false);
	});

	describe('cold start / import — a large batch with nothing synced yet', () => {
		it('cold start: a fresh device with a large existing library covers all of it on the first full pass', async () => {
			// Mirrors the client engine's first sync after `/api/sync` drains a big backlog of pulled
			// tracking events: local `tracking` is populated, but no media has ever been hydrated on
			// this device (no local `media` rows at all).
			const total = MEDIA_SYNC_MAX + 220;
			const externalIds = await trackMany(total, 'cold-start');

			const sent: MediaSyncRequest[] = [];
			const result = await runMediaSync({ fullCheck: true }, stubCaughtUp(sent));

			expect(haveIdsSent(sent)).toEqual(new Set(externalIds.map((e) => mediaId('tmdb', e))));
			expect(result.truncated).toBe(false);
		});

		it('import: a bulk-restored library is fully covered by the light pass (all rows unsynced)', async () => {
			const total = MEDIA_SYNC_MAX + 75;
			const externalIds = await trackMany(total, 'import');
			// `applyImport` seeds a scalar-only snapshot per title (version: 0) before the events sync —
			// mirrors that, so every title is "unsynced" and picked up by the light pass.
			for (const externalId of externalIds) await putMedia(record(externalId, { version: 0 }));

			const sent: MediaSyncRequest[] = [];
			const result = await runMediaSync({ fullCheck: false }, stubCaughtUp(sent));

			expect(haveIdsSent(sent)).toEqual(new Set(externalIds.map((e) => mediaId('tmdb', e))));
			expect(sent.flatMap((req) => req.have).every((h) => h.version === 0)).toBe(true);
			expect(result.truncated).toBe(false);
		});
	});
});
