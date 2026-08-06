import { describe, expect, it } from 'vitest';
import { chunkBySize, chunkIds, chunkRows, D1_MAX_BOUND_PARAMS, ID_CHUNK } from './chunk';

describe('chunkBySize', () => {
	it('yields no chunks for an empty list', () => {
		expect(chunkBySize([], 10)).toEqual([]);
	});

	it('keeps a list shorter than the size in one chunk', () => {
		expect(chunkBySize([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
	});

	it('splits on an exact multiple without a trailing empty chunk', () => {
		expect(chunkBySize([1, 2, 3, 4], 2)).toEqual([
			[1, 2],
			[3, 4]
		]);
	});

	it('puts the remainder in a final short chunk', () => {
		expect(chunkBySize([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
	});

	it('preserves order and loses nothing', () => {
		const items = Array.from({ length: 197 }, (_, i) => i);
		expect(chunkBySize(items, 20).flat()).toEqual(items);
	});
});

describe('chunkIds', () => {
	it('caps each chunk at ID_CHUNK, below D1 the bound-parameter limit', () => {
		const ids = Array.from({ length: ID_CHUNK * 2 + 5 }, (_, i) => `id-${i}`);
		const chunks = chunkIds(ids);
		expect(chunks).toHaveLength(3);
		for (const c of chunks) expect(c.length).toBeLessThanOrEqual(ID_CHUNK);
		expect(ID_CHUNK).toBeLessThan(D1_MAX_BOUND_PARAMS);
		expect(chunks.flat()).toEqual(ids);
	});
});

describe('chunkRows', () => {
	it('derives the chunk size from the column count so no chunk exceeds the param limit', () => {
		// 8 columns → floor(100 / 8) = 12 rows per insert.
		const rows = Array.from({ length: 50 }, (_, i) => ({
			a: i,
			b: i,
			c: i,
			d: i,
			e: i,
			f: i,
			g: i,
			h: i
		}));
		const chunks = chunkRows(rows);
		for (const c of chunks) {
			expect(c.length * 8).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
		}
		expect(chunks[0]).toHaveLength(12);
		expect(chunks.flat()).toEqual(rows);
	});

	it('still emits one row per chunk when a row alone would exceed the limit', () => {
		const wide = Object.fromEntries(
			Array.from({ length: D1_MAX_BOUND_PARAMS + 20 }, (_, i) => [`c${i}`, i])
		);
		expect(chunkRows([wide, wide])).toEqual([[wide], [wide]]);
	});

	it('yields no chunks for an empty list', () => {
		expect(chunkRows([])).toEqual([]);
	});
});
