/**
 * The tape's maths — pure and DOM-free, so the feel can be table-tested.
 *
 * One tile is always one event: the tape never decimates or skips. Range comes from motion (a fling
 * crosses hundreds of events a second) and from the pitch, so a log of thousands costs exactly the
 * same DOM as a log of twenty — `visibleRange` is the whole trick, and it is the only reason
 * "thousands of events" is a non-issue rather than a performance problem.
 */
import type { EventEnvelope } from './events.js';

/** px per event: a broad sweep, the default rhythm, and single-event precision. */
export const PITCHES = [10, 28, 44] as const;

/** Index into `PITCHES` the tape opens on. */
export const DEFAULT_PITCH = 1;

/** Above this speed (events/second) tiles become placeholders — nobody reads a fling. */
export const TILE_SPEED_LIMIT = 60;

/** Momentum decay per 60Hz frame, and the speed at which a fling hands over to the settle. */
export const FLING_DECAY = 0.94;
export const FLING_REST_SPEED = 1.5;

/**
 * An index is a position in `0..length`, where `length` is "now" (the newest end of the log) and `0`
 * is before the first event ever recorded.
 */
export function clampIndex(index: number, length: number): number {
	return Math.max(0, Math.min(length, index));
}

/** The event an index settles on. The tape always comes to rest on a whole event, never between. */
export function settleIndex(index: number, length: number): number {
	return Math.round(clampIndex(index, length));
}

/** The continuous index an offset (in px) puts under the pointer. */
export function indexAtOffset(offsetPx: number, pitch: number): number {
	return offsetPx / pitch;
}

/** The offset (in px) that puts `index` under the pointer — the inverse of `indexAtOffset`. */
export function offsetForIndex(index: number, pitch: number): number {
	return index * pitch;
}

/**
 * Where a fling comes to rest: each frame keeps `FLING_DECAY` of the speed, so the total travel is a
 * geometric series — `v · dt / (1 − decay)` — and a fling never carries past either end of the log.
 */
export function flingRest(index: number, velocity: number, length: number): number {
	const travel = (velocity * (1 / 60)) / (1 - FLING_DECAY);
	return clampIndex(index + travel, length);
}

/** Whether tiles say anything at this speed, or are placeholders. */
export function tilesRenderable(eventsPerSecond: number): boolean {
	return Math.abs(eventsPerSecond) < TILE_SPEED_LIMIT;
}

/**
 * The window of indices worth rendering: what the viewport covers either side of the pointer, plus
 * `overscan` tiles so a drag doesn't reveal an empty edge. Bounded by `length`, so the DOM is a
 * function of the viewport and the pitch — never of the log.
 */
export function visibleRange(
	index: number,
	pitch: number,
	width: number,
	length: number,
	overscan = 6
): { start: number; end: number } {
	if (!(pitch > 0) || !(length > 0)) return { start: 0, end: 0 };
	const span = Math.ceil(width / 2 / pitch) + overscan;
	return {
		start: Math.max(0, Math.floor(index) - span),
		end: Math.min(length, Math.ceil(index) + span)
	};
}

/** A jump chip: the day, and the index that stands at the end of it. */
export interface DayAnchor {
	step: number;
	label: string;
}

/**
 * One chip per local calendar day, newest first, each pointing at the index that ends that day (so
 * today's chip is "now"). Capped at `max` because a year of days is not a jump control — the filter
 * and the tape are for the rest.
 */
export function dayAnchors(log: readonly EventEnvelope[], max = 7): DayAnchor[] {
	const format = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' });
	const chips: DayAnchor[] = [];
	let currentDay = '';
	for (let i = log.length - 1; i >= 0 && chips.length < max; i--) {
		const date = new Date(log[i].clientCreatedAt);
		const day = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
		if (day === currentDay) continue;
		currentDay = day;
		chips.push({ step: i + 1, label: format.format(date) });
	}
	return chips;
}
