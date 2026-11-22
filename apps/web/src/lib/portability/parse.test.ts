import { describe, expect, it } from 'vitest';
import { parseExport } from './parse';
import { EXPORT_FORMAT, EXPORT_SCHEMA_VERSION, type MarqueeExport } from './schema';

function doc(overrides: Partial<MarqueeExport> = {}): MarqueeExport {
	return {
		format: EXPORT_FORMAT,
		schemaVersion: EXPORT_SCHEMA_VERSION,
		exportedAt: '2026-08-01T14:22:03.451Z',
		titleCount: 1,
		titles: [
			{
				mediaId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
				provider: 'tmdb',
				externalId: 'show/95396',
				type: 'show',
				title: 'Severance',
				year: 2022,
				status: 'watching',
				favorite: true,
				rating: 4,
				addedAt: '2026-03-11T09:04:00.000Z',
				statusChangedAt: '2026-06-20T18:00:00.000Z',
				watchedEpisodes: [{ season: 1, episode: 1, watchedAt: '2026-06-20T18:00:00.000Z' }]
			}
		],
		...overrides
	};
}

describe('parseExport', () => {
	it('accepts a well-formed document', () => {
		const result = parseExport(JSON.stringify(doc()));

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.doc.titles).toHaveLength(1);
		expect(result.doc.titles[0].title).toBe('Severance');
	});

	it('accepts an entry with no media metadata', () => {
		const result = parseExport(
			JSON.stringify(
				doc({
					titles: [
						{
							mediaId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
							provider: null,
							externalId: null,
							type: null,
							title: null,
							year: null,
							status: 'want_to_watch',
							favorite: false,
							rating: null,
							addedAt: '2026-03-11T09:04:00.000Z',
							statusChangedAt: '2026-03-11T09:04:00.000Z',
							watchedEpisodes: []
						}
					]
				})
			)
		);

		expect(result.ok).toBe(true);
	});

	it('carries the watched dates through', () => {
		const result = parseExport(JSON.stringify(doc()));

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.doc.titles[0].statusChangedAt).toBe('2026-06-20T18:00:00.000Z');
		expect(result.doc.titles[0].watchedEpisodes[0].watchedAt).toBe('2026-06-20T18:00:00.000Z');
	});

	it('rejects an episode with no watched date, which would lose when it was seen', () => {
		const stripped = doc();
		const result = parseExport(
			JSON.stringify({
				...stripped,
				titles: [{ ...stripped.titles[0], watchedEpisodes: [{ season: 1, episode: 1 }] }]
			})
		);

		expect(result).toEqual({ ok: false, reason: 'invalid' });
	});

	it('rejects text that is not JSON', () => {
		const result = parseExport('not json at all');

		expect(result).toEqual({ ok: false, reason: 'not_json' });
	});

	it('rejects a truncated document', () => {
		const result = parseExport(JSON.stringify(doc()).slice(0, 60));

		expect(result).toEqual({ ok: false, reason: 'not_json' });
	});

	it('rejects valid JSON that is not a Marquee export', () => {
		const result = parseExport(JSON.stringify({ films: ['Inception'] }));

		expect(result).toEqual({ ok: false, reason: 'wrong_format' });
	});

	it('rejects a schema version newer than we understand', () => {
		const result = parseExport(JSON.stringify(doc({ schemaVersion: 99 })));

		expect(result).toEqual({ ok: false, reason: 'unsupported_version' });
	});

	it('rejects a document whose titles are malformed', () => {
		const bad = { ...doc(), titles: [{ mediaId: 'x', status: 'not-a-status' }] };
		const result = parseExport(JSON.stringify(bad));

		expect(result).toEqual({ ok: false, reason: 'invalid' });
	});

	it('tolerates unknown extra keys so a newer minor format still imports', () => {
		const extended = { ...doc(), somethingNew: true };
		const result = parseExport(JSON.stringify(extended));

		expect(result.ok).toBe(true);
	});
});
