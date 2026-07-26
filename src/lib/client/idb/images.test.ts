import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, setActiveUser } from './db';
import { getMediaImages, pruneMediaImages } from './images';

setActiveUser('images-test');

/** Insert a bare mediaImages row with a controlled `updatedAt` for LRU ordering. */
async function putRaw(id: string, updatedAt: number) {
	const db = await openDb();
	await db.put('mediaImages', { id, poster: null, backdrop: null, updatedAt });
}

beforeEach(async () => {
	const db = await openDb();
	await db.clear('mediaImages'); // fake-indexeddb persists across a file's tests
});

describe('pruneMediaImages', () => {
	it('drops blobs for ids outside the keep set', async () => {
		await putRaw('keep-1', 1);
		await putRaw('drop-1', 2);
		await putRaw('keep-2', 3);

		const deleted = await pruneMediaImages(new Set(['keep-1', 'keep-2']));

		expect(deleted).toBe(1);
		expect(await getMediaImages('drop-1')).toBeUndefined();
		expect(await getMediaImages('keep-1')).toBeDefined();
		expect(await getMediaImages('keep-2')).toBeDefined();
	});

	it('evicts the least-recently-updated survivors past the cap', async () => {
		await putRaw('old', 10);
		await putRaw('mid', 20);
		await putRaw('new', 30);

		const deleted = await pruneMediaImages(new Set(['old', 'mid', 'new']), 2);

		expect(deleted).toBe(1);
		expect(await getMediaImages('old')).toBeUndefined(); // oldest evicted
		expect(await getMediaImages('mid')).toBeDefined();
		expect(await getMediaImages('new')).toBeDefined();
	});

	it('keeps everything when nothing is orphaned and the cap isn’t exceeded', async () => {
		await putRaw('a', 1);
		await putRaw('b', 2);
		expect(await pruneMediaImages(new Set(['a', 'b']))).toBe(0);
	});
});
