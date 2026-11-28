import { describe, expect, it } from 'vitest';
import type { AddonAction, LibraryEvent, MediaType } from './addon';
import { toIntent } from './intent';

const event = (
	overrides: Partial<LibraryEvent> & { type?: MediaType; action?: AddonAction } = {}
): LibraryEvent => ({
	type: 'movie',
	id: 'tt0133093',
	action: 'watched',
	videoIds: [],
	...overrides
});

describe('toIntent', () => {
	it('adds a title to the list without asserting a status', () => {
		// No `status`: a re-add must not overwrite a title the user already finished.
		expect(toIntent(event({ action: 'libraryAdd' }))).toEqual({ removed: false });
		expect(toIntent(event({ type: 'show', action: 'libraryAdd' }))).toEqual({ removed: false });
	});

	it('removes a title from the list', () => {
		expect(toIntent(event({ action: 'libraryRemove' }))).toEqual({ removed: true });
	});

	it('treats a watched movie as completed and an unwatched one as back on the list', () => {
		expect(toIntent(event({ action: 'watched' }))).toEqual({ status: 'completed' });
		expect(toIntent(event({ action: 'unwatched' }))).toEqual({ status: 'want_to_watch' });
	});

	// A movie's videoId, when it has one, is the title itself and names no episode.
	it('ignores a movie videoId', () => {
		expect(toIntent(event({ action: 'watched', videoIds: ['tt0133093'] }))).toEqual({
			status: 'completed'
		});
	});

	it('marks the episodes a series event names', () => {
		expect(
			toIntent(
				event({
					type: 'show',
					id: 'tt0944947',
					action: 'watched',
					videoIds: ['tt0944947:1:1', 'tt0944947:1:2', 'tt0944947:0:1']
				})
			)
		).toEqual({
			episodes: [
				{ season: 1, episode: 1, watched: true },
				{ season: 1, episode: 2, watched: true },
				{ season: 0, episode: 1, watched: true }
			]
		});
	});

	it('un-marks the same episodes', () => {
		expect(
			toIntent(event({ type: 'show', id: 'tt1', action: 'unwatched', videoIds: ['tt1:2:5'] }))
		).toEqual({ episodes: [{ season: 2, episode: 5, watched: false }] });
	});

	// The product rule, revised: a bare gesture on a show is a claim about the whole title, so it is
	// sent as one field and the server decides which episodes that means. VideoIds that were present
	// but unparseable are a different case — they must not widen to the series.
	it('sends a bare watch as a whole-title intent', () => {
		expect(toIntent(event({ type: 'show', action: 'watched', videoIds: [] }))).toEqual({
			allEpisodes: { watched: true }
		});
	});

	// Additive acts; destructive waits. A whole-title clear destroys history the log cannot restore,
	// and the addon surface authenticates on a URL — so it is acknowledged and does nothing until
	// the bridge can ask its owner.
	it('does not act on a bare un-watch of a whole title', () => {
		expect(toIntent(event({ type: 'show', action: 'unwatched', videoIds: [] }))).toBeNull();
	});

	it('does not widen to the whole title when the videoIds were merely unparseable', () => {
		expect(toIntent(event({ type: 'show', id: 'tt1', videoIds: ['tt1:1'] }))).toBeNull();
		expect(toIntent(event({ type: 'show', id: 'tt1', videoIds: ['tt2:1:1'] }))).toBeNull();
	});

	it('drops a videoId that is not a season:episode of this title', () => {
		for (const videoId of [
			'tt1:1',
			'tt1:1:2:3',
			'tt1:1:0',
			'tt1:-1:2',
			'tt1:one:two',
			'tt1:',
			// `Number('')` is 0 and `Number('0x2')` is 2, so coercion alone would accept these.
			'tt1::2',
			'tt1:0x2:3',
			'tt1:1:2.5',
			'tt0000001:1:1'
		]) {
			expect(toIntent(event({ type: 'show', id: 'tt1', videoIds: [videoId] }))).toBeNull();
		}
	});

	it('keeps the episodes that do parse and drops the ones that do not', () => {
		expect(
			toIntent(event({ type: 'show', id: 'tt1', videoIds: ['tt1:1:1', 'tt1:1', 'tt1:1:2'] }))
		).toEqual({
			episodes: [
				{ season: 1, episode: 1, watched: true },
				{ season: 1, episode: 2, watched: true }
			]
		});
	});
});
