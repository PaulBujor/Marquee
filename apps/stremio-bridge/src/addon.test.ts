import { describe, expect, it } from 'vitest';
import { manifest, parseLibraryEvent } from './addon';

describe('manifest', () => {
	const m = manifest('sbr_handle');

	// Claiming the `library` resource on `tt` ids is the whole reason Stremio routes events here;
	// an addon that claims neither is never asked.
	it('claims library on imdb ids, and no catalogs', () => {
		expect(m.resources).toEqual(['library']);
		expect(m.types).toEqual(['movie', 'series']);
		expect(m.idPrefixes).toEqual(['tt']);
		expect(m.catalogs).toEqual([]);
		expect(m.behaviorHints).toEqual({ adult: false });
	});

	it('identifies the pairing rather than the deployment', () => {
		expect(m.id).toContain('sbr_handle');
		expect(manifest('sbr_other').id).not.toBe(m.id);
	});
});

describe('parseLibraryEvent', () => {
	it('translates a series to a show and leaves a movie alone', () => {
		expect(parseLibraryEvent('movie', 'tt1', 'action=watched')).toEqual({
			kind: 'event',
			event: { type: 'movie', id: 'tt1', action: 'watched', videoIds: [] }
		});
		expect(parseLibraryEvent('series', 'tt2', 'action=watched')).toMatchObject({
			event: { type: 'show' }
		});
	});

	// One event can carry a whole season, so the list is not an edge case to tolerate but the
	// normal shape: eight ids were observed in a single request.
	it('decodes a comma-separated videoId list', () => {
		const parsed = parseLibraryEvent(
			'series',
			'tt2',
			'action=watched&videoId=tt2%3A1%3A1%2Ctt2%3A1%3A2%2Ctt2%3A1%3A3'
		);

		expect(parsed).toMatchObject({ event: { videoIds: ['tt2:1:1', 'tt2:1:2', 'tt2:1:3'] } });
	});

	it('takes the commas literally too', () => {
		expect(
			parseLibraryEvent('series', 'tt2', 'action=watched&videoId=tt2%3A1%3A1,tt2%3A1%3A2')
		).toMatchObject({ event: { videoIds: ['tt2:1:1', 'tt2:1:2'] } });
	});

	it('carries every action Stremio sends', () => {
		for (const action of ['libraryAdd', 'libraryRemove', 'watched', 'unwatched'] as const) {
			expect(parseLibraryEvent('movie', 'tt1', `action=${action}`)).toMatchObject({
				event: { action }
			});
		}
	});

	// A bare `watched` on a show means "mark nothing", never "every episode".
	it('reports an absent videoId as an empty list, not as all episodes', () => {
		expect(parseLibraryEvent('series', 'tt2', 'action=watched')).toMatchObject({
			event: { videoIds: [] }
		});
	});

	it('ignores the types Marquee does not model', () => {
		for (const type of ['channel', 'tv', '']) {
			expect(parseLibraryEvent(type, 'tt1', 'action=watched')).toEqual({
				kind: 'ignored',
				reason: `type:${type}`
			});
		}
	});

	it('ignores an action it does not know, including none at all', () => {
		expect(parseLibraryEvent('movie', 'tt1', 'action=')).toEqual({
			kind: 'ignored',
			reason: 'action:none'
		});
		expect(parseLibraryEvent('movie', 'tt1', 'action=played')).toEqual({
			kind: 'ignored',
			reason: 'action:played'
		});
		expect(parseLibraryEvent('movie', 'tt1', undefined)).toEqual({
			kind: 'ignored',
			reason: 'action:none'
		});
	});

	// A garbled request must not look like a deliberate one.
	it('treats a malformed escape or a missing id as an invalid path', () => {
		expect(parseLibraryEvent('movie', 'tt1', 'action=watched&videoId=tt%')).toEqual({
			kind: 'invalid'
		});
		expect(parseLibraryEvent('movie', '', 'action=watched')).toEqual({ kind: 'invalid' });
	});

	it('survives stray separators rather than throwing', () => {
		expect(parseLibraryEvent('movie', 'tt1', '&&action=watched&&')).toMatchObject({
			event: { action: 'watched' }
		});
	});

	// `idPrefixes` is a routing hint Stremio honours, not a gate we control.
	it('rejects an id that is not an imdb id', () => {
		for (const id of ['yt:abc', 'tt12x', 'tt', '1tt1', 'tt%2F1']) {
			expect(parseLibraryEvent('movie', id, 'action=watched')).toEqual({ kind: 'invalid' });
		}
	});

	// A videoId naming another title would put an episode watch on the wrong show.
	it('keeps only the videoIds that belong to the event id', () => {
		expect(
			parseLibraryEvent(
				'series',
				'tt2',
				'action=watched&videoId=tt2%3A1%3A1,tt0133093%3A1%3A1,tt2%3A1%3A2'
			)
		).toMatchObject({ event: { videoIds: ['tt2:1:1', 'tt2:1:2'] } });
	});

	// A client that repeats the parameter instead of joining the list must not lose all but the last.
	it('collects every videoId parameter', () => {
		expect(
			parseLibraryEvent('series', 'tt2', 'action=watched&videoId=tt2%3A1%3A1&videoId=tt2%3A1%3A2')
		).toMatchObject({ event: { videoIds: ['tt2:1:1', 'tt2:1:2'] } });
	});
});
