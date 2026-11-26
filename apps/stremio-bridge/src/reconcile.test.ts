import { describe, expect, it } from 'vitest';
import {
	planReconcile,
	type MarqueeTitle,
	type ReconcileInput,
	type StremioItem
} from './reconcile';
import {
	libraryItem,
	watchedBitfield,
	type LibraryItem,
	type LibraryItemState
} from './testing/stremio';

const SERIES = 'tt0944947';
const KEYS = [`${SERIES}:1:1`, `${SERIES}:1:2`, `${SERIES}:1:3`];
const bitfield = watchedBitfield(KEYS);

/** A series exactly as Stremio stores one: the bitfield indexed by the catalogue order above. */
function seriesItem(
	options: {
		watched?: string[];
		item?: Partial<LibraryItem>;
		state?: Partial<LibraryItemState>;
	} = {}
): LibraryItem {
	const { watched = [], item = {}, state = {} } = options;
	const base = libraryItem({ _id: SERIES, name: 'Breaking Bad', type: 'series' });

	return {
		...base,
		...item,
		state: {
			...base.state,
			...state,
			watched: bitfield.encode(watched),
			video_id: watched[0] ?? KEYS[0]
		}
	};
}

/** Marquee's side of one title, already restated in Stremio's vocabulary. */
const title = (overrides: Partial<MarqueeTitle> = {}): MarqueeTitle => ({
	id: SERIES,
	type: 'show',
	removed: false,
	watched: [],
	...overrides
});

const plan = (input: Partial<ReconcileInput> = {}) =>
	planReconcile({
		entries: [],
		items: [],
		snapshot: {},
		videoKeys: { [SERIES]: KEYS },
		...input
	});

/** A put is typed with the fields the merge reads; the runtime value is the whole item it read. */
const asItem = (put: StremioItem): LibraryItem => put as LibraryItem;

describe('agreement', () => {
	it('writes nothing when both sides already match', () => {
		const item = seriesItem({ watched: [KEYS[0]] });
		const agreed = { removed: false, watched: [KEYS[0]] };

		const result = plan({
			items: [item],
			entries: [title({ watched: [KEYS[0]] })],
			snapshot: { [SERIES]: agreed }
		});

		expect(result.puts).toEqual([]);
		expect(result.commands).toEqual([]);
		expect(result.conflicts).toEqual([]);
		expect(result.snapshot[SERIES]).toEqual(agreed);
	});
});

describe('Marquee moved, Stremio still equals the snapshot', () => {
	it('echoes the full item for a tombstone, keeping every field it did not change', () => {
		const item = seriesItem({
			watched: [KEYS[1], KEYS[2]],
			item: { behaviorHints: { hasScheduledVideos: true, defaultVideoId: KEYS[0] } },
			state: { timeOffset: 12_345, duration: 3_600_000 }
		});

		const result = plan({
			items: [item],
			entries: [title({ removed: true, watched: [KEYS[1], KEYS[2]] })],
			snapshot: { [SERIES]: { removed: false, watched: [KEYS[1], KEYS[2]] } }
		});

		expect(result.puts).toHaveLength(1);
		const put = asItem(result.puts[0]);
		expect(put.removed).toBe(true);
		expect(put.temp).toBe(false);
		// `datastorePut` replaces: everything the merge did not decide has to still be in the write.
		expect(put).toMatchObject({
			_id: SERIES,
			name: 'Breaking Bad',
			type: 'series',
			poster: item.poster,
			posterShape: item.posterShape,
			_ctime: item._ctime,
			behaviorHints: item.behaviorHints
		});
		expect(put.state).toMatchObject({ timeOffset: 12_345, duration: 3_600_000 });

		expect(result.snapshot[SERIES]).toEqual({ removed: true, watched: [KEYS[1], KEYS[2]] });
	});

	it('unions the watched set into the bitfield, through the real codec', () => {
		const item = seriesItem({ watched: [KEYS[0]] });

		const result = plan({
			items: [item],
			entries: [title({ watched: [KEYS[0], KEYS[2]] })],
			snapshot: { [SERIES]: { removed: false, watched: [KEYS[0]] } }
		});

		expect(bitfield.decode(result.puts[0]?.state?.watched ?? '')).toEqual([KEYS[0], KEYS[2]]);
		expect(result.snapshot[SERIES]).toEqual({ removed: false, watched: [KEYS[0], KEYS[2]] });
	});

	it('never deletes a watched bit: an un-watch in Marquee is a loss, not a write', () => {
		const result = plan({
			items: [seriesItem({ watched: KEYS })],
			entries: [title({ watched: [KEYS[0]] })],
			snapshot: { [SERIES]: { removed: false, watched: KEYS } }
		});

		expect(result.puts).toEqual([]);
		expect(result.commands).toEqual([]);
		expect(result.snapshot[SERIES]).toEqual({ removed: false, watched: KEYS });
	});

	it('never turns a removal into an unwatch of everything on the title', () => {
		const result = plan({
			items: [seriesItem({ watched: KEYS })],
			entries: [title({ removed: true, watched: [] })],
			snapshot: { [SERIES]: { removed: false, watched: KEYS } }
		});

		const put = asItem(result.puts[0]);
		expect(put.removed).toBe(true);
		// The bitfield is how progress survives a removal, so the tombstone must carry it untouched.
		expect(bitfield.decode(put.state.watched)).toEqual(KEYS);
		expect(result.commands).toEqual([]);
	});

	it('keeps the item on Stremio when Marquee re-adds a title Stremio tombstoned', () => {
		const item = seriesItem({ watched: [KEYS[0]], item: { removed: true } });

		const result = plan({
			items: [item],
			entries: [title({ removed: false, watched: [KEYS[0]] })],
			snapshot: { [SERIES]: { removed: true, watched: [KEYS[0]] } }
		});

		expect(result.puts[0]).toMatchObject({ removed: false, temp: false });
		expect(result.snapshot[SERIES]).toEqual({ removed: false, watched: [KEYS[0]] });
	});
});

describe('Stremio moved', () => {
	it('reports a conflict and writes nothing in either direction', () => {
		const result = plan({
			items: [seriesItem({ watched: [KEYS[0]], item: { removed: true } })],
			entries: [title({ watched: [KEYS[0]] })],
			snapshot: { [SERIES]: { removed: false, watched: [KEYS[0]] } }
		});

		expect(result.conflicts).toEqual([{ id: SERIES, reason: 'stremio-changed' }]);
		expect(result.puts).toEqual([]);
		expect(result.commands).toEqual([]);
		// The snapshot does not move: the next run has to see the same divergence.
		expect(result.snapshot[SERIES]).toEqual({ removed: false, watched: [KEYS[0]] });
	});
});

describe('adopting Stremio', () => {
	it('folds "played but never added" into tracked, with its watch state', () => {
		const result = plan({
			items: [seriesItem({ watched: [KEYS[0]], item: { temp: true, removed: true } })]
		});

		expect(result.puts).toEqual([]);
		expect(result.commands).toEqual([
			{
				type: 'show',
				id: SERIES,
				removed: false,
				episodes: [{ season: 1, episode: 1, watched: true }]
			}
		]);
		expect(result.snapshot[SERIES]).toEqual({ removed: false, watched: [KEYS[0]] });
	});

	it('never pushes a removal into Marquee, which would take the progress with it', () => {
		const result = plan({
			items: [seriesItem({ watched: [KEYS[0]], item: { temp: false, removed: true } })],
			entries: [title({ watched: [KEYS[0]] })]
		});

		expect(result.commands).toEqual([]);
		expect(result.puts).toEqual([]);
		expect(result.snapshot[SERIES]).toEqual({ removed: true, watched: [KEYS[0]] });
	});

	it('reads a watched movie as a completed status', () => {
		const watched = libraryItem({ state: { watched: ['tt0133093'] } });

		const result = plan({ items: [watched], videoKeys: {} });

		expect(result.commands).toEqual([
			{ type: 'movie', id: 'tt0133093', removed: false, status: 'completed' }
		]);
	});

	it('lists an unwatched movie it has never seen without inventing a status', () => {
		const result = plan({ items: [libraryItem()], videoKeys: {} });

		expect(result.commands).toEqual([{ type: 'movie', id: 'tt0133093', removed: false }]);
	});
});

describe('what it refuses to decide', () => {
	it('will not address a title Stremio never had', () => {
		const result = plan({ entries: [title()] });

		expect(result.conflicts).toEqual([{ id: SERIES, reason: 'not-in-stremio' }]);
		expect(result.puts).toEqual([]);
		expect(result.snapshot).toEqual({});
	});

	it('refuses a projection entry that is not an IMDb id', () => {
		const result = plan({ entries: [title({ id: 'tmdb:1396' })] });

		expect(result.conflicts).toEqual([{ id: 'tmdb:1396', reason: 'invalid-entry' }]);
	});

	it('refuses a projection that contradicts the item it names', () => {
		const result = plan({ items: [seriesItem()], entries: [title({ type: 'movie' })] });

		expect(result.conflicts).toEqual([{ id: SERIES, reason: 'type-mismatch' }]);
	});

	it('skips a series whose catalogue ordering is unknown', () => {
		const result = planReconcile({
			items: [seriesItem({ watched: [KEYS[0]] })],
			entries: [],
			snapshot: {},
			videoKeys: {}
		});

		expect(result.conflicts).toEqual([{ id: SERIES, reason: 'no-video-keys' }]);
		expect(result.puts).toEqual([]);
		expect(result.commands).toEqual([]);
		expect(result.snapshot).toEqual({});
	});

	it('skips a bitfield it cannot read against the ordering it has', () => {
		const base = seriesItem();
		// First one ends at a video this catalogue does not know; the second is not a bitfield at all.
		const elsewhere = watchedBitfield([`${SERIES}:9:9`]).encode([`${SERIES}:9:9`]);

		for (const watched of [elsewhere, 'garbage']) {
			const result = plan({ items: [{ ...base, state: { ...base.state, watched } }] });

			expect(result.conflicts).toEqual([{ id: SERIES, reason: 'unreadable-watched' }]);
		}
	});

	it('conflicts rather than throwing on an item with no state to read', () => {
		const base = seriesItem();

		for (const item of [
			{ ...base, state: undefined },
			{ ...base, state: { watched: 42 as unknown as string } }
		]) {
			const result = plan({ items: [item] });

			expect(result.conflicts).toEqual([{ id: SERIES, reason: 'unreadable-watched' }]);
		}
	});

	// The stored field names its own universe size, so a shorter catalogue would drop bits while
	// still reporting a set — that is a conflict, not a resize.
	it('skips a field written over a longer universe than the caller has', () => {
		const base = seriesItem();
		const longer = `${SERIES}:1:2:3:AA==`;

		const result = planReconcile({
			items: [{ ...base, state: { ...base.state, watched: longer } }],
			entries: [],
			snapshot: {},
			videoKeys: { [SERIES]: KEYS.slice(0, 2) }
		});

		expect(result.conflicts).toEqual([{ id: SERIES, reason: 'unreadable-watched' }]);
	});

	it('forgets a title both sides have dropped', () => {
		const result = plan({ snapshot: { [SERIES]: { removed: true, watched: [] } } });

		expect(result.snapshot).toEqual({});
		expect(result.conflicts).toEqual([]);
	});
});

describe('writing only what actually changed', () => {
	// Stremio writes one bitfield per episode count, so a stored field can cover fewer videos than the
	// catalogue and still name the same set. Re-encoding it would be a write for no reason.
	it('does not re-encode a shorter field that already means the same', () => {
		const base = seriesItem();
		const shorter = watchedBitfield([KEYS[0], KEYS[1]]).encode([KEYS[0]]);

		const result = plan({
			items: [{ ...base, state: { ...base.state, watched: shorter } }],
			// Marquee dropped the bit: an un-watch is not expressible, so there is nothing to write.
			entries: [title({ watched: [] })],
			snapshot: { [SERIES]: { removed: false, watched: [KEYS[0]] } }
		});

		expect(result.puts).toEqual([]);
		expect(result.snapshot[SERIES]).toEqual({ removed: false, watched: [KEYS[0]] });
	});

	// A `temp` item is outside the user's library: agreeing on the values is not enough when Marquee
	// tracks the title, or it would never enter that library.
	it('promotes a temp item that Marquee already tracks', () => {
		const item = seriesItem({ watched: [KEYS[0]], item: { temp: true, removed: true } });

		const result = plan({
			items: [item],
			entries: [title({ watched: [KEYS[0]] })],
			snapshot: { [SERIES]: { removed: false, watched: [KEYS[0]] } }
		});

		expect(result.puts).toHaveLength(1);
		expect(result.puts[0]).toMatchObject({ removed: false, temp: false });
		expect(bitfield.decode(result.puts[0]?.state?.watched ?? '')).toEqual([KEYS[0]]);
		expect(result.commands).toEqual([]);
	});
});
