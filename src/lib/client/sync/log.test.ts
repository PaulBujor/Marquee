import { describe, expect, it } from 'vitest';
import { appendEntry, formatLogText, parseEntries, type SyncLogEntry } from './log';

const entry = (
	at: number,
	message: string,
	level: SyncLogEntry['level'] = 'info'
): SyncLogEntry => ({
	at,
	message,
	level,
	channel: 'events'
});

describe('appendEntry', () => {
	it('puts the newest entry first', () => {
		const first = entry(1, 'a');
		const second = entry(2, 'b');
		expect(appendEntry([first], second).map((e) => e.message)).toEqual(['b', 'a']);
	});

	it('drops the oldest past the cap', () => {
		const existing = [entry(3, 'c'), entry(2, 'b'), entry(1, 'a')];
		const capped = appendEntry(existing, entry(4, 'd'), 3);
		expect(capped.map((e) => e.message)).toEqual(['d', 'c', 'b']);
	});

	it('does not mutate the list it was given', () => {
		const existing = [entry(1, 'a')];
		appendEntry(existing, entry(2, 'b'));
		expect(existing).toHaveLength(1);
	});
});

describe('formatLogText', () => {
	it('reads oldest first, so a copied log runs forwards in time', () => {
		const text = formatLogText([entry(2, 'second'), entry(1, 'first')]);
		expect(text.split('\n').map((l) => l.replace(/^\S+ /, ''))).toEqual([
			'[events] first',
			'[events] second'
		]);
	});

	it('marks non-info levels and leaves info unprefixed', () => {
		expect(formatLogText([entry(1, 'boom', 'error')])).toContain('[events] error: boom');
		expect(formatLogText([entry(1, 'fine')])).toContain('[events] fine');
	});
});

describe('parseEntries', () => {
	it('is empty for nothing stored', () => {
		expect(parseEntries(null)).toEqual([]);
	});

	it('is empty for malformed json rather than throwing', () => {
		expect(parseEntries('{oops')).toEqual([]);
		expect(parseEntries('"a string"')).toEqual([]);
	});

	it('keeps well-formed entries and drops the rest', () => {
		const raw = JSON.stringify([entry(1, 'good'), { at: 'nope' }, null, { message: 'no at' }]);
		expect(parseEntries(raw).map((e) => e.message)).toEqual(['good']);
	});
});
