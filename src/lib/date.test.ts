import { describe, expect, it } from 'vitest';
import { formatExactDateTime, formatRelativeDay } from './date';

// Local-time constructors throughout: the helper counts local calendar days, so building the
// fixtures the same way keeps the assertions true in any timezone the suite runs in.
const NOW = new Date(2026, 6, 24, 14, 30).getTime(); // 24 July 2026, early afternoon
const at = (year: number, month: number, day: number, hour = 12) =>
	new Date(year, month, day, hour).getTime();

describe('formatRelativeDay', () => {
	it('reads the same calendar day as today, whatever the time of day', () => {
		expect(formatRelativeDay(at(2026, 6, 24, 0), NOW)).toBe('Today');
		expect(formatRelativeDay(at(2026, 6, 24, 23), NOW)).toBe('Today');
	});

	it('counts calendar days, not elapsed hours', () => {
		// Late yesterday to early today is a few hours, but it's still "Yesterday".
		expect(formatRelativeDay(at(2026, 6, 23, 23), new Date(2026, 6, 24, 1).getTime())).toBe(
			'Yesterday'
		);
	});

	it('counts up in days through the rest of the week', () => {
		expect(formatRelativeDay(at(2026, 6, 22), NOW)).toBe('2 days ago');
		expect(formatRelativeDay(at(2026, 6, 18), NOW)).toBe('6 days ago');
	});

	it('switches to an absolute date at a week old', () => {
		const formatted = formatRelativeDay(at(2026, 6, 17), NOW);
		expect(formatted).not.toMatch(/ago|Today|Yesterday/);
		expect(formatted).toContain('2026');
	});

	it('dates something from a previous year', () => {
		const formatted = formatRelativeDay(at(2024, 0, 15), NOW);
		expect(formatted).toContain('2024');
	});

	it('treats a future timestamp as today (a peer device with a fast clock)', () => {
		expect(formatRelativeDay(at(2026, 6, 25), NOW)).toBe('Today');
		expect(formatRelativeDay(at(2027, 0, 1), NOW)).toBe('Today');
	});
});

describe('formatExactDateTime', () => {
	it('spells out the date and time', () => {
		const formatted = formatExactDateTime(at(2026, 6, 24, 21));
		expect(formatted).toContain('2026');
		expect(formatted).toMatch(/\d{1,2}[:.]\d{2}/);
	});
});
