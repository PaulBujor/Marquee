import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { mediaId, type MediaRecord } from '$lib/sync/events';
import { setActiveUser } from '$lib/client/idb/db';
import { getEpisodes, getMedia, putMedia } from '$lib/client/idb/media';
import type { MediaSyncRequest, MediaSyncResponse } from '$lib/sync/media-protocol';
import { MAX_DRAIN_ITERATIONS, runMediaSync } from './media-sync';

setActiveUser('media-sync-test');

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

describe('runMediaSync', () => {
	it('reports local media versions in `have` and stores what the server returns', async () => {
		const mid = mediaId('tmdb', 'movie/603');
		await putMedia(record('movie/603', { version: 1 }));

		const sent: MediaSyncRequest[] = [];
		const result = await runMediaSync(
			stubFetch([record('movie/603', { version: 2, title: 'updated' })], sent)
		);

		expect(sent[0].have).toContainEqual({ id: mid, version: 1 });
		expect(await getMedia(mid)).toMatchObject({ id: mid, title: 'updated', version: 2 });
		expect(result.applied).toBe(1);
	});

	it('pushes identity refs for locally-known linked media', async () => {
		await putMedia(record('movie/778'));
		const sent: MediaSyncRequest[] = [];
		await runMediaSync(stubFetch([], sent));
		expect(sent[0].refs).toContainEqual({ provider: 'tmdb', externalId: 'movie/778' });
	});

	it('fans a returned show record out into the seasons/episodes stores', async () => {
		const showId = mediaId('tmdb', 'show/1396');
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
		await runMediaSync(stubFetch([show], sent));

		expect(await getMedia(showId)).toMatchObject({ id: showId, type: 'show', version: 3 });
		const eps = await getEpisodes(showId);
		expect(eps.map((e) => [e.season, e.episode, e.airDate])).toEqual([
			[1, 1, '2008-01-20'],
			[1, 2, '2008-01-27']
		]);
	});

	it('loops until the server stops flagging `pending`, accumulating applied', async () => {
		const sent: MediaSyncRequest[] = [];
		const result = await runMediaSync(
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
		expect(result.applied).toBe(3);
	});

	it('bounds the drain loop when the server never clears `pending`', async () => {
		const sent: MediaSyncRequest[] = [];
		await runMediaSync(stubResponses([{ media: [], pending: true }], sent));
		expect(sent).toHaveLength(MAX_DRAIN_ITERATIONS); // capped, not infinite
	});
});
