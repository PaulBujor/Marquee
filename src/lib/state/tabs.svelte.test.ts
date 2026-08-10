import { describe, expect, it } from 'vitest';
import { TabsState } from './tabs.svelte';

const url = (path: string) => new URL(path, 'https://marquee.test');

describe('TabsState.record', () => {
	it('remembers the last URL of each tab, query included', () => {
		const tabs = new TabsState();
		tabs.record(url('/search?q=dune'));
		tabs.record(url('/?tab=watching'));
		expect(tabs.href('search')).toBe('/search?q=dune');
		expect(tabs.href('dashboard')).toBe('/?tab=watching');
	});

	it('falls back to the root for a tab never visited', () => {
		const tabs = new TabsState();
		expect(tabs.href('settings')).toBe('/settings');
	});

	it('tracks the owning tab', () => {
		const tabs = new TabsState();
		expect(tabs.owner).toBe('dashboard');
		tabs.record(url('/timeline'));
		expect(tabs.owner).toBe('timeline');
	});

	it('leaves both untouched on a route no tab owns', () => {
		const tabs = new TabsState();
		tabs.record(url('/search?q=alien'));
		tabs.record(url('/title/movie/1'));
		expect(tabs.owner).toBe('search');
		expect(tabs.href('search')).toBe('/search?q=alien');
	});
});

describe('TabsState scroll restore', () => {
	it('returns the captured offset once, to the tab it was armed for', () => {
		const tabs = new TabsState();
		tabs.captureScroll('/', 1200);
		tabs.armRestore('dashboard');
		expect(tabs.takeRestore('dashboard')).toBe(1200);
		expect(tabs.takeRestore('dashboard')).toBeNull();
	});

	it('returns null when nothing was armed', () => {
		const tabs = new TabsState();
		tabs.captureScroll('/', 900);
		expect(tabs.takeRestore('dashboard')).toBeNull();
	});

	it('clears a mismatched arm rather than letting it fire later', () => {
		const tabs = new TabsState();
		tabs.captureScroll('/', 900);
		tabs.armRestore('dashboard');
		expect(tabs.takeRestore('timeline')).toBeNull();
		expect(tabs.takeRestore('dashboard')).toBeNull();
	});

	it('is null for an arrival on no tab at all', () => {
		const tabs = new TabsState();
		tabs.armRestore('dashboard');
		expect(tabs.takeRestore(null)).toBeNull();
	});

	it('ignores a capture from a route no tab owns', () => {
		const tabs = new TabsState();
		tabs.captureScroll('/title/movie/1', 4000);
		tabs.armRestore('dashboard');
		expect(tabs.takeRestore('dashboard')).toBe(0);
	});
});

describe('TabsState signals', () => {
	it('increments the search focus ticket on every request', () => {
		const tabs = new TabsState();
		expect(tabs.searchFocusRequest).toBe(0);
		tabs.requestSearchFocus();
		tabs.requestSearchFocus();
		expect(tabs.searchFocusRequest).toBe(2);
	});

	it('offers and clears the scroll undo', () => {
		const tabs = new TabsState();
		expect(tabs.undoOffer).toBeNull();
		tabs.offerUndo(1500);
		expect(tabs.undoOffer).toBe(1500);
		tabs.clearUndo();
		expect(tabs.undoOffer).toBeNull();
	});
});

describe('TabsState.reset', () => {
	it('drops every trace of the previous account', () => {
		const tabs = new TabsState();
		tabs.record(url('/search?q=dune'));
		tabs.captureScroll('/search', 800);
		tabs.armRestore('search');
		tabs.offerUndo(400);

		tabs.reset();

		expect(tabs.href('search')).toBe('/search');
		expect(tabs.owner).toBe('dashboard');
		expect(tabs.undoOffer).toBeNull();
		expect(tabs.takeRestore('search')).toBeNull();
		tabs.armRestore('search');
		expect(tabs.takeRestore('search')).toBe(0);
	});
});
