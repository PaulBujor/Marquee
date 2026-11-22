import { describe, expect, it } from 'vitest';
import { detailRoute } from './detail-route';

const MID = '77777777-7777-4777-8777-777777777777';

describe('detailRoute', () => {
	it('addresses a provider-backed title by its provider id', () => {
		expect(detailRoute({ mediaId: MID, source: 'linked', externalId: 'movie/603' })).toEqual({
			kind: 'title',
			type: 'movie',
			id: '603'
		});
		expect(detailRoute({ mediaId: MID, source: 'linked', externalId: 'show/1396' })).toEqual({
			kind: 'title',
			type: 'show',
			id: '1396'
		});
	});

	it('addresses a custom entry by our own id', () => {
		expect(detailRoute({ mediaId: MID, source: 'custom', externalId: null })).toEqual({
			kind: 'custom',
			id: MID
		});
	});

	it('has no route for a title whose media has not synced yet', () => {
		// Previously this produced `/title/movie/` — a link that looked fine and 404'd on tap. It is
		// also why `source` is needed and `externalId === null` alone is not enough to spot a custom
		// entry: an unsynced provider-backed title looks identical by that test.
		expect(detailRoute({ mediaId: MID, source: null, externalId: null })).toBeNull();
	});

	it('has no route for an unparseable provider id', () => {
		expect(detailRoute({ mediaId: MID, source: 'linked', externalId: 'nonsense' })).toBeNull();
		expect(detailRoute({ mediaId: MID, source: 'linked', externalId: 'movie/' })).toBeNull();
		expect(detailRoute({ mediaId: MID, source: 'linked', externalId: 'movie/0' })).toBeNull();
	});

	it('takes the type from the provider id, which is what the route resolves against', () => {
		expect(detailRoute({ mediaId: MID, source: 'linked', externalId: 'show/1396' })).toMatchObject({
			type: 'show'
		});
	});

	it('routes a custom entry by source even if an external id somehow lingers', () => {
		// Source is the authority: a linked entry keeps its own id, and the custom row it was matched
		// from stays reachable at its own page.
		expect(detailRoute({ mediaId: MID, source: 'custom', externalId: 'movie/603' })).toEqual({
			kind: 'custom',
			id: MID
		});
	});
});
