import { describe, expect, it } from 'vitest';
import { createEvent, type EventEnvelope } from './events.js';
import {
	DEFAULT_PITCH,
	PITCHES,
	TILE_SPEED_LIMIT,
	clampIndex,
	dayAnchors,
	flingRest,
	indexAtOffset,
	offsetForIndex,
	settleIndex,
	tilesRenderable,
	visibleRange
} from './tape.js';

describe('index and offset', () => {
	it('round-trips at every pitch', () => {
		for (const pitch of PITCHES) {
			for (const index of [0, 1, 7, 42, 1499]) {
				expect(indexAtOffset(offsetForIndex(index, pitch), pitch)).toBeCloseTo(index, 10);
			}
		}
	});

	it('preserves the anchor across a pitch change', () => {
		const index = 312.5;
		for (const pitch of PITCHES) {
			// The same index sits under the pointer whatever the zoom.
			expect(indexAtOffset(offsetForIndex(index, pitch), pitch)).toBeCloseTo(index, 10);
		}
	});

	it('has a default pitch that shows a readable slice and still crosses range', () => {
		expect(PITCHES[DEFAULT_PITCH]).toBe(28);
		expect(PITCHES[0]).toBeLessThan(PITCHES[DEFAULT_PITCH]);
		expect(PITCHES[PITCHES.length - 1]).toBeGreaterThan(PITCHES[DEFAULT_PITCH]);
	});
});

describe('the ends', () => {
	it('clamps inside the log, so the tape cannot scroll past either end', () => {
		expect(clampIndex(-40, 500)).toBe(0);
		expect(clampIndex(900, 500)).toBe(500);
		expect(clampIndex(500, 500)).toBe(500);
	});

	it('settles on a whole event even when clamped', () => {
		expect(settleIndex(-0.6, 500)).toBe(0);
		expect(settleIndex(500.6, 500)).toBe(500);
		expect(settleIndex(12.4, 500)).toBe(12);
		expect(settleIndex(12.6, 500)).toBe(13);
	});

	it('keeps a mid-fling index inside the log at both ends', () => {
		expect(flingRest(1, -900, 500)).toBe(0);
		expect(flingRest(499, 900, 500)).toBe(500);
	});
});

describe('momentum', () => {
	it('lands on a whole event', () => {
		for (const velocity of [-120, -18, 0, 18, 120]) {
			const rest = flingRest(120, velocity, 5000);
			expect(Number.isInteger(settleIndex(rest, 5000))).toBe(true);
			expect(settleIndex(rest, 5000)).toBeCloseTo(Math.round(rest), 10);
		}
	});

	it('carries further the faster the fling', () => {
		const slow = flingRest(100, 30, 5000) - 100;
		const fast = flingRest(100, 300, 5000) - 100;
		expect(fast).toBeGreaterThan(slow);
		expect(slow).toBeGreaterThan(0);
	});
});

describe('tile rendering threshold', () => {
	it('renders real tiles at rest and placeholders above the limit', () => {
		expect(tilesRenderable(0)).toBe(true);
		expect(tilesRenderable(TILE_SPEED_LIMIT - 1)).toBe(true);
		expect(tilesRenderable(TILE_SPEED_LIMIT + 1)).toBe(false);
		expect(tilesRenderable(-TILE_SPEED_LIMIT - 1)).toBe(false);
	});
});

describe('visibleRange', () => {
	it('renders a fixed-size window, however long the log is', () => {
		const short = visibleRange(10, 28, 400, 20);
		const long = visibleRange(10, 28, 400, 20_000);
		expect(long.start).toBe(0);
		expect(short.end).toBe(20);
		expect(long.end - long.start).toBeLessThanOrEqual(60);
	});

	it('follows the pointer without growing', () => {
		const near = visibleRange(4000, 28, 400, 20_000);
		const further = visibleRange(8000, 28, 400, 20_000);
		expect(near.end - near.start).toBe(further.end - further.start);
		expect(further.start).toBeGreaterThan(near.start);
	});

	it('zooms out with a smaller pitch', () => {
		const wide = visibleRange(500, 10, 400, 20_000);
		const precise = visibleRange(500, 44, 400, 20_000);
		expect(wide.end - wide.start).toBeGreaterThan(precise.end - precise.start);
	});

	it('is empty for a log with no events', () => {
		expect(visibleRange(0, 28, 400, 0)).toEqual({ start: 0, end: 0 });
	});
});

describe('dayAnchors', () => {
	function ev(clock: number): EventEnvelope {
		return createEvent('tracking.added', `movie/${clock}`, { status: 'watching' }, 'device', clock);
	}

	it('puts one chip on each local day, newest first, pointing at the day it ends', () => {
		const at = (iso: string) => new Date(`${iso}T12:00:00`).getTime();
		const log = [
			ev(at('2026-01-01')),
			ev(at('2026-01-01') + 1000),
			ev(at('2026-01-02')),
			ev(at('2026-01-04'))
		];
		const chips = dayAnchors(log);
		expect(chips).toHaveLength(3);
		expect(chips[0].step).toBe(4); // today ends at "now"
		expect(chips[1].step).toBe(3);
		expect(chips[2].step).toBe(2);
	});

	it('caps the list, and an empty log has no chips', () => {
		const at = (day: number) => new Date(2026, 0, day, 12).getTime();
		const log = Array.from({ length: 12 }, (_, i) => ev(at(i + 1)));
		expect(dayAnchors(log, 5)).toHaveLength(5);
		expect(dayAnchors([])).toEqual([]);
	});
});
