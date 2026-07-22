import { describe, expect, it } from 'vitest';
import {
	createEvent,
	episodeKey,
	EVENT_SCHEMA_VERSION,
	mediaId,
	trackingKey,
	validateEvent,
	type EventEnvelope
} from './events';

const DEVICE = '11111111-1111-1111-1111-111111111111';

describe('key helpers', () => {
	it('builds deterministic ids', () => {
		expect(mediaId('movie', 603)).toBe('movie:603');
		expect(mediaId('show', 1396)).toBe('show:1396');
		expect(trackingKey('u1', 'movie:603')).toBe('u1::movie:603');
		expect(episodeKey('u1', 'show:1396', 2, 5)).toBe('u1::show:1396::s2e5');
	});
});

describe('createEvent', () => {
	it('stamps id, clientCreatedAt and schema version', () => {
		const ev = createEvent('tracking.favorite_toggled', 'movie:603', { favorite: true }, DEVICE);
		expect(ev.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(typeof ev.clientCreatedAt).toBe('number');
		expect(ev.schemaVersion).toBe(EVENT_SCHEMA_VERSION);
		expect(ev.deviceId).toBe(DEVICE);
		expect(validateEvent(ev)).not.toBeNull();
	});
});

describe('validateEvent', () => {
	it('accepts every well-formed event type', () => {
		const cases: EventEnvelope[] = [
			createEvent('tracking.added', 'movie:603', { status: 'watching' }, DEVICE),
			createEvent('tracking.status_changed', 'movie:603', { status: 'completed' }, DEVICE),
			createEvent('tracking.status_changed', 'movie:603', { status: 'did_not_finish' }, DEVICE),
			createEvent('tracking.favorite_toggled', 'movie:603', { favorite: false }, DEVICE),
			createEvent('tracking.rated', 'movie:603', { rating: 5 }, DEVICE),
			createEvent('tracking.rated', 'movie:603', { rating: null }, DEVICE),
			createEvent('episode.watched', 'show:1396', { season: 1, episode: 2 }, DEVICE),
			createEvent('episode.unwatched', 'show:1396', { season: 1, episode: 2 }, DEVICE),
			// Season 0 is valid — TMDB numbers Specials as season 0.
			createEvent('episode.watched', 'show:1396', { season: 0, episode: 1 }, DEVICE),
			createEvent('tracking.removed', 'movie:603', {}, DEVICE)
		];
		for (const ev of cases) expect(validateEvent(ev)).toEqual(ev);
	});

	it('rejects malformed events', () => {
		const good = createEvent(
			'tracking.status_changed',
			'movie:603',
			{ status: 'watching' },
			DEVICE
		);
		expect(validateEvent(null)).toBeNull();
		expect(validateEvent({ ...good, type: 'nope' })).toBeNull();
		expect(validateEvent({ ...good, id: 'not-a-uuid' })).toBeNull();
		expect(validateEvent({ ...good, deviceId: 'not-a-uuid' })).toBeNull();
		expect(validateEvent({ ...good, entityId: '' })).toBeNull();
		expect(validateEvent({ ...good, clientCreatedAt: 'soon' })).toBeNull();
		expect(validateEvent({ ...good, clientCreatedAt: 0 })).toBeNull();
		expect(validateEvent({ ...good, clientCreatedAt: 1.5 })).toBeNull(); // non-integer
		expect(validateEvent({ ...good, clientCreatedAt: 4102444800000 })).toBeNull(); // year 2100
		// bad payloads
		expect(validateEvent({ ...good, payload: { status: 'invalid' } })).toBeNull();
		expect(
			validateEvent(
				createEvent('episode.watched', 'show:1396', { season: 1.5, episode: 2 }, DEVICE)
			)
		).toBeNull();
		// episode is 1-based (0 rejected); a negative season is rejected
		expect(
			validateEvent(createEvent('episode.watched', 'show:1396', { season: 1, episode: 0 }, DEVICE))
		).toBeNull();
		expect(
			validateEvent(createEvent('episode.watched', 'show:1396', { season: -1, episode: 1 }, DEVICE))
		).toBeNull();
		// schemaVersion must be a positive integer
		expect(validateEvent({ ...good, schemaVersion: 0 })).toBeNull();
		expect(
			validateEvent({
				...createEvent('tracking.added', 'movie:603', { status: 'watching' }, DEVICE),
				payload: { status: 'invalid' } // bad status
			})
		).toBeNull();
		// rating out of the 1–5 range
		expect(
			validateEvent({
				...createEvent('tracking.rated', 'movie:603', { rating: 5 }, DEVICE),
				payload: { rating: 6 }
			})
		).toBeNull();
		expect(
			validateEvent({
				...createEvent('tracking.rated', 'movie:603', { rating: 5 }, DEVICE),
				payload: { rating: 0 }
			})
		).toBeNull();
	});
});
