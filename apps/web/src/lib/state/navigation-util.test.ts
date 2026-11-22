import { describe, expect, it } from 'vitest';
import { entryOrigin, initialNavState, recordNavigation } from './navigation-util';

const url = (path: string) => new URL(path, 'https://marquee.app');

describe('recordNavigation', () => {
	it('leaves the state untouched on a cold entry (null/undefined from)', () => {
		expect(recordNavigation(initialNavState, null)).toBe(initialNavState);
		expect(recordNavigation(initialNavState, undefined)).toBe(initialNavState);
	});

	it('flips canGoBack on and records the origin for an in-app navigation', () => {
		const next = recordNavigation(initialNavState, url('/search?q=dune'));
		expect(next.canGoBack).toBe(true);
		expect(next.lastFrom).toBe('/search?q=dune');
	});

	it('keeps canGoBack true and updates lastFrom across subsequent navigations', () => {
		const first = recordNavigation(initialNavState, url('/'));
		const second = recordNavigation(first, url('/title/show/123'));
		expect(second.canGoBack).toBe(true);
		expect(second.lastFrom).toBe('/title/show/123');
	});

	it('does not downgrade canGoBack when a later navigation has no origin', () => {
		const first = recordNavigation(initialNavState, url('/'));
		const second = recordNavigation(first, null);
		expect(second).toBe(first);
		expect(second.canGoBack).toBe(true);
	});
});

describe('entryOrigin', () => {
	it('returns home for a cold entry', () => {
		expect(entryOrigin(null)).toBe('/');
	});

	it('remembers home and a search (with its query), never another title', () => {
		expect(entryOrigin('/')).toBe('/');
		expect(entryOrigin('/search?q=dune')).toBe('/search?q=dune');
		expect(entryOrigin('/title/movie/42')).toBe('/');
		expect(entryOrigin('/settings')).toBe('/');
	});
});
