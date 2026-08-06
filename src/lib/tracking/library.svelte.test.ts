import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { putMedia, recordEvent, setActiveUser } from '$lib/client/idb';
import { tmdbMediaId, type MediaRecord } from '$lib/sync/events';
import { LibraryState } from './library.svelte';

setActiveUser('test-user'); // the store is namespaced per user; scope it before opening

const MID = tmdbMediaId('show', 9999);

const baseMedia: Omit<MediaRecord, 'episodes' | 'seasons'> = {
	id: MID,
	provider: 'tmdb',
	externalId: 'show/9999',
	source: 'linked',
	type: 'show',
	title: 'A Finished Show',
	year: 2020,
	posterPath: null,
	backdropPath: null,
	overview: '',
	genres: [],
	releaseDate: null,
	status: 'Ended',
	inProduction: false,
	firstAirDate: '2020-01-01',
	lastAirDate: '2020-01-08',
	version: 1
};

/**
 * Exercises the actual render call path — `LibraryState.load()` reading real IndexedDB stores
 * written through the real `recordEvent`/`putMedia` primitives — rather than calling `deriveStatus`
 * directly. `derive-status.test.ts` already covers the derivation exhaustively at the function
 * level; what that can't catch is a render site passing the wrong arguments to a correct function,
 * which is the actual shape at least two of the four status bugs in this area have taken.
 */
describe('LibraryState.load — the reported bug, through the real IndexedDB call path', () => {
	it('resolves to completed once episode metadata arrives, from watches recorded while it had none — with no further write', async () => {
		// Season summary known (the title is being tracked, TMDB detail already fetched) but
		// per-episode air dates haven't synced locally yet — the media row exists with no episodes,
		// mirroring the window between adding a show and the media channel's first pull landing.
		await putMedia({ ...baseMedia, seasons: [], episodes: [] });

		// The user bulk-marks the season watched from summary counts alone (episodesToMark), which
		// records one `episode.watched` per episode through the real event pipeline (recordEvent →
		// outbox + applyEventToIdb) — the same path a live "mark season watched" action takes.
		await recordEvent('tracking.added', MID, { status: 'watching' });
		await recordEvent('episode.watched', MID, { season: 1, episode: 1 });
		await recordEvent('episode.watched', MID, { season: 1, episode: 2 });

		const library = new LibraryState();
		await library.load();
		const before = library.items.find((i) => i.mediaId === MID);
		expect(before?.status).toBe('watching'); // deferred, not guessed at — no episode data yet

		// The media channel now delivers the real per-episode data (a finished, two-episode season,
		// both already watched above) via the same `putMedia` call the production media-sync path
		// uses. No further tracking or episode event is recorded — nothing else changes.
		await putMedia({
			...baseMedia,
			seasons: [
				{
					seasonNumber: 1,
					name: 'Season 1',
					overview: '',
					airDate: '2020-01-01',
					posterPath: null,
					episodeCount: 2
				}
			],
			episodes: [
				{
					season: 1,
					episode: 1,
					name: 'E1',
					overview: '',
					airDate: '2020-01-01',
					runtime: 42,
					stillPath: null
				},
				{
					season: 1,
					episode: 2,
					name: 'E2',
					overview: '',
					airDate: '2020-01-08',
					runtime: 42,
					stillPath: null
				}
			]
		});

		await library.load();
		const after = library.items.find((i) => i.mediaId === MID);
		expect(after?.status).toBe('completed'); // resolved on the next read alone
	});
});
