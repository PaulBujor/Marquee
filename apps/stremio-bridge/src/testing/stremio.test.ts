import { describe, expect, it } from 'vitest';
import {
	addonEventRequest,
	libraryItem,
	stremioAccountApi,
	watchedBitfield,
	type LibraryItem,
	type StremioAccountApi
} from './stremio';

const post = (api: StremioAccountApi, endpoint: string, body: unknown) =>
	api.fetch(`https://api.strem.io/api/${endpoint}`, {
		method: 'POST',
		body: JSON.stringify(body)
	});

const get = async (api: StremioAccountApi, body: unknown) =>
	(await (await post(api, 'datastoreGet', body)).json()) as { result: LibraryItem[] };

describe('stremioAccountApi', () => {
	it('round-trips an item through datastorePut and datastoreGet', async () => {
		const api = stremioAccountApi();
		const item = libraryItem({ _id: 'tt0944947', name: 'Game of Thrones', type: 'series' });

		const put = await post(api, 'datastorePut', {
			authKey: 'marquee-test-auth-key',
			collection: 'libraryItem',
			changes: [item]
		});
		expect(put.status).toBe(200);
		expect(await put.json()).toEqual({ result: true });

		expect(
			await get(api, { authKey: 'marquee-test-auth-key', collection: 'libraryItem', all: true })
		).toEqual({ result: [item] });

		// The double asserts the documented request shape back, so a drifting caller fails here.
		expect(api.requests.map((request) => request.url)).toEqual([
			'https://api.strem.io/api/datastorePut',
			'https://api.strem.io/api/datastoreGet'
		]);
		expect(api.requests[0].body).toEqual({
			authKey: 'marquee-test-auth-key',
			collection: 'libraryItem',
			changes: [item]
		});
		expect(api.requests[1].body).toEqual({
			authKey: 'marquee-test-auth-key',
			collection: 'libraryItem',
			all: true
		});
	});

	it('returns only the requested ids', async () => {
		const api = stremioAccountApi({
			items: [libraryItem({ _id: 'tt0133093' }), libraryItem({ _id: 'tt0944947' })]
		});

		const { result } = await get(api, {
			authKey: 'marquee-test-auth-key',
			collection: 'libraryItem',
			ids: ['tt0944947']
		});

		expect(result.map((item) => item._id)).toEqual(['tt0944947']);
	});

	// A removal is a tombstone, not a delete: dropping the row would make Stremio's next
	// write resurrect a title the user removed.
	it('keeps a removed item instead of deleting it', async () => {
		const api = stremioAccountApi();
		const removed = libraryItem({ _id: 'tt0133093', removed: true });

		await post(api, 'datastorePut', {
			authKey: 'marquee-test-auth-key',
			collection: 'libraryItem',
			changes: [removed]
		});

		const { result } = await get(api, {
			authKey: 'marquee-test-auth-key',
			collection: 'libraryItem',
			all: true
		});
		expect(result).toHaveLength(1);
		expect(result[0].removed).toBe(true);
	});

	it('answers an unknown authKey with the sync-disabled envelope at HTTP 200', async () => {
		const api = stremioAccountApi({ items: [libraryItem()] });

		for (const endpoint of ['datastoreGet', 'datastorePut', 'datastoreMeta']) {
			const res = await post(api, endpoint, { authKey: 'not-mine', collection: 'libraryItem' });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ error: { code: 5992, message: 'Sync disabled' } });
		}
	});

	it('treats a datastorePut with no changes as a no-op', async () => {
		const api = stremioAccountApi({ items: [libraryItem({ _id: 'tt0133093' })] });
		const before = await get(api, {
			authKey: 'marquee-test-auth-key',
			collection: 'libraryItem',
			all: true
		});

		const res = await post(api, 'datastorePut', {
			authKey: 'marquee-test-auth-key',
			collection: 'libraryItem',
			changes: []
		});
		expect(await res.json()).toEqual({ result: true });

		const after = await get(api, {
			authKey: 'marquee-test-auth-key',
			collection: 'libraryItem',
			all: true
		});
		expect(after).toEqual(before);
	});

	it('logs in with the documented body', async () => {
		const api = stremioAccountApi();

		const res = await post(api, 'login', {
			email: 'user@example.com',
			password: 'correct-horse-battery-staple'
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			result: {
				authKey: 'marquee-test-auth-key',
				user: { _id: 'marquee-test-user', email: 'user@example.com' }
			}
		});
		expect(api.requests[0].body).toEqual({
			email: 'user@example.com',
			password: 'correct-horse-battery-staple'
		});
	});
});

describe('watchedBitfield', () => {
	const keys = ['1', '2', '3', '4', '5', '6', '7', '8'];

	it('round-trips a sparse set', () => {
		const bits = watchedBitfield(keys);
		expect(bits.decode(bits.encode(['1', '3', '7']))).toEqual(['1', '3', '7']);
	});

	it('round-trips an empty set', () => {
		const bits = watchedBitfield(keys);
		expect(bits.decode(bits.encode([]))).toEqual([]);
	});

	it('serializes episodes in the item id:length:buffer form', () => {
		const bits = watchedBitfield(keys);
		expect(bits.encode(['1']).split(':').slice(0, 2)).toEqual(['8', '8']);
	});
});

describe('addonEventRequest', () => {
	it('builds the movie URL Stremio calls', () => {
		expect(
			addonEventRequest({ handle: 'abc123', type: 'movie', id: 'tt0133093', action: 'watched' }).url
		).toBe('https://bridge.test/abc123/library/movie/tt0133093/action=watched.json');
	});

	it('carries the season:episode videoId for a series', () => {
		expect(
			addonEventRequest({
				handle: 'abc123',
				type: 'series',
				id: 'tt0944947',
				action: 'watched',
				videoId: 'tt0944947:1:1'
			}).url
		).toBe(
			'https://bridge.test/abc123/library/series/tt0944947/action=watched&videoId=tt0944947%3A1%3A1.json'
		);
	});

	// Stremio sends a path segment, but the protocol allows the query string too, so both are expressible.
	it('can encode the extra props as the query string instead', () => {
		expect(
			addonEventRequest({
				handle: 'abc123',
				type: 'series',
				id: 'tt0944947',
				action: 'unwatched',
				videoId: 'tt0944947:2:5',
				extra: 'query',
				origin: 'https://marquee-bridge.example'
			}).url
		).toBe(
			'https://marquee-bridge.example/abc123/library/series/tt0944947.json?action=unwatched&videoId=tt0944947%3A2%3A5'
		);
	});
});
