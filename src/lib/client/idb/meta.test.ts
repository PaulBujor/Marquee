import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { FULL_MEDIA_CHECK_MS, isFullMediaCheckDue } from '$lib/client/sync/media-gate';
import { setActiveUser } from './db';
import {
	addRecentSearch,
	clearRecentSearches,
	getLastFullMediaCheck,
	getRecentSearches,
	setLastFullMediaCheck
} from './meta';

setActiveUser('meta-test-user');

describe('getLastFullMediaCheck / setLastFullMediaCheck', () => {
	it('defaults to 0 (forces a full check) when never persisted', async () => {
		expect(await getLastFullMediaCheck()).toBe(0);
	});

	it('round-trips a persisted watermark', async () => {
		await setLastFullMediaCheck(12345);
		expect(await getLastFullMediaCheck()).toBe(12345);
	});

	it('respects the full-check cadence across a simulated relaunch', async () => {
		const sessionOneNow = 1_000_000;
		// Session 1 ran a full check and persisted the watermark before the tab closed.
		await setLastFullMediaCheck(sessionOneNow);

		// Relaunch: a fresh engine instance has no in-memory watermark and must load the
		// persisted one instead of defaulting back to 0.
		const relaunchWatermark = await getLastFullMediaCheck();
		expect(relaunchWatermark).toBe(sessionOneNow);

		const shortlyAfterRelaunch = sessionOneNow + 60_000; // well under FULL_MEDIA_CHECK_MS
		expect(isFullMediaCheckDue(relaunchWatermark, shortlyAfterRelaunch)).toBe(false);
		// Without persistence the relaunch would have reset to 0, which *would* be due immediately —
		// the assertion below guards against regressing to that behavior.
		expect(isFullMediaCheckDue(0, shortlyAfterRelaunch)).toBe(true);

		const afterCadence = sessionOneNow + FULL_MEDIA_CHECK_MS;
		expect(isFullMediaCheckDue(relaunchWatermark, afterCadence)).toBe(true);
	});
});

describe('recent searches', () => {
	it('starts empty when nothing has been recorded', async () => {
		await clearRecentSearches();
		expect(await getRecentSearches()).toEqual([]);
	});

	it('records a search as the most recent entry', async () => {
		await clearRecentSearches();
		await addRecentSearch('dune');
		expect(await getRecentSearches()).toEqual(['dune']);
	});

	it('puts the newest search first', async () => {
		await clearRecentSearches();
		await addRecentSearch('dune');
		await addRecentSearch('arrival');
		expect(await getRecentSearches()).toEqual(['arrival', 'dune']);
	});

	it('caps the list at 25 entries, dropping the oldest', async () => {
		await clearRecentSearches();
		const queries = Array.from({ length: 30 }, (_, i) => `q${i}`);
		for (const q of queries) await addRecentSearch(q);
		const recent = await getRecentSearches();
		expect(recent).toHaveLength(25);
		expect(recent[0]).toBe('q29');
		expect(recent.at(-1)).toBe('q5');
		expect(recent).not.toContain('q4');
	});

	it('bumps a repeated query to the top instead of duplicating it', async () => {
		await clearRecentSearches();
		await addRecentSearch('dune');
		await addRecentSearch('arrival');
		await addRecentSearch('dune');
		expect(await getRecentSearches()).toEqual(['dune', 'arrival']);
	});

	it('trims whitespace before comparing and storing', async () => {
		await clearRecentSearches();
		await addRecentSearch('dune');
		await addRecentSearch('  dune  ');
		expect(await getRecentSearches()).toEqual(['dune']);
	});

	it('ignores blank queries', async () => {
		await clearRecentSearches();
		await addRecentSearch('   ');
		expect(await getRecentSearches()).toEqual([]);
	});

	it('returns the updated list so callers can update UI state directly', async () => {
		await clearRecentSearches();
		const result = await addRecentSearch('dune');
		expect(result).toEqual(['dune']);
	});

	it('clears all recorded searches', async () => {
		await addRecentSearch('dune');
		await clearRecentSearches();
		expect(await getRecentSearches()).toEqual([]);
	});
});
