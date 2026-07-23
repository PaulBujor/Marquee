import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { mediaId, type MediaRecord } from '$lib/sync/events';
import { setActiveUser } from '$lib/client/idb/db';
import { putMedia } from '$lib/client/idb/media';
import { getMediaImages, putMediaImages } from '$lib/client/idb/images';
import { IMAGE_SYNC_MAX, runImageSync } from './image-sync';

setActiveUser('image-sync-test');

function media(externalId: string): MediaRecord {
	return {
		id: mediaId('tmdb', externalId),
		provider: 'tmdb',
		externalId,
		source: 'linked',
		type: 'movie',
		title: externalId,
		year: 1999,
		posterPath: '/p.jpg',
		backdropPath: '/b.jpg',
		overview: '',
		genres: [],
		seasons: null
	};
}

/** A fetch stub returning 3 bytes, counting calls. */
function stub() {
	let calls = 0;
	const fetchFn = (async () => {
		calls++;
		return new Response(new Blob([new Uint8Array([1, 2, 3])]), { status: 200 });
	}) as unknown as typeof fetch;
	return { fetchFn, calls: () => calls };
}

describe('runImageSync', () => {
	it('fetches poster + backdrop blobs for cached media and stores them', async () => {
		await putMedia(media('movie/603'));
		const { fetchFn } = stub();
		const result = await runImageSync(fetchFn);

		const imgs = await getMediaImages(mediaId('tmdb', 'movie/603'));
		expect(imgs?.poster?.size).toBeGreaterThan(0);
		expect(imgs?.backdrop?.size).toBeGreaterThan(0);
		expect(result.stored).toBe(1);
	});

	it('skips media whose images are already cached', async () => {
		const id = mediaId('tmdb', 'movie/778');
		await putMedia(media('movie/778'));
		await putMediaImages(id, {
			poster: new Blob([new Uint8Array([9])]),
			backdrop: new Blob([new Uint8Array([9])])
		});
		const { fetchFn, calls } = stub();
		await runImageSync(fetchFn);
		expect(calls()).toBe(0); // nothing left to fetch
	});

	it('bounds how many titles it fetches per run', async () => {
		for (let i = 0; i < IMAGE_SYNC_MAX + 3; i++) await putMedia(media(`movie/${1000 + i}`));
		const { fetchFn } = stub();
		const result = await runImageSync(fetchFn);
		expect(result.stored).toBe(IMAGE_SYNC_MAX);
	});
});
