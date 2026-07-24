import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createEvent, mediaId, type MediaRecord } from '$lib/sync/events';
import { setActiveUser } from '$lib/client/idb/db';
import { applyEventToIdb } from '$lib/client/idb/state';
import { getMedia, putMedia } from '$lib/client/idb/media';
import type { MediaSyncRequest } from '$lib/sync/media-protocol';
import { runMediaSync } from './media-sync';

setActiveUser('media-sync-test');
const DEVICE = '11111111-1111-1111-1111-111111111111';

function record(externalId: string): MediaRecord {
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
		seasons: null
	};
}

describe('runMediaSync', () => {
	it('requests media referenced by tracking but missing locally, and stores what comes back', async () => {
		const mid = mediaId('tmdb', 'movie/603');
		// A tracked title (from an event) with no local media row yet.
		await applyEventToIdb(createEvent('tracking.added', mid, { status: 'want_to_watch' }, DEVICE));

		const sent: MediaSyncRequest[] = [];
		const fetchFn = (async (_url: string, init: RequestInit) => {
			sent.push(JSON.parse(init.body as string) as MediaSyncRequest);
			return new Response(JSON.stringify({ media: [record('movie/603')] }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}) as unknown as typeof fetch;

		const result = await runMediaSync(fetchFn);

		expect(sent[0].need).toContain(mid); // asked for the missing media
		expect(await getMedia(mid)).toMatchObject({ id: mid, title: 'title-movie/603' });
		expect(result.applied).toBe(1);
	});

	it('pushes identity refs for locally-known linked media', async () => {
		await putMedia(record('movie/778')); // a locally-captured title
		const sent: MediaSyncRequest[] = [];
		const fetchFn = (async (_url: string, init: RequestInit) => {
			sent.push(JSON.parse(init.body as string) as MediaSyncRequest);
			return new Response(JSON.stringify({ media: [] }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}) as unknown as typeof fetch;

		await runMediaSync(fetchFn);
		expect(sent[0].refs).toContainEqual({ provider: 'tmdb', externalId: 'movie/778' });
	});
});
