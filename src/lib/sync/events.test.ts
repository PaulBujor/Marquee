import { describe, expect, it } from 'vitest';
import {
	createEvent,
	episodeKey,
	EVENT_SCHEMA_VERSION,
	mediaId,
	trackingKey,
	validateEvent,
	type EventEnvelope,
	type MediaSnapshot
} from './events';

const DEVICE = '11111111-1111-1111-1111-111111111111';
const SNAPSHOT: MediaSnapshot = {
	tmdbId: 603,
	type: 'movie',
	title: 'The Matrix',
	year: 1999,
	posterPath: '/m.jpg',
	overview: 'x'
};

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
			createEvent('tracking.added', 'movie:603', { media: SNAPSHOT, status: 'watching' }, DEVICE),
			createEvent('tracking.status_changed', 'movie:603', { status: 'completed' }, DEVICE),
			createEvent('tracking.favorite_toggled', 'movie:603', { favorite: false }, DEVICE),
			createEvent('episode.watched', 'show:1396', { season: 1, episode: 2 }, DEVICE),
			createEvent('episode.unwatched', 'show:1396', { season: 1, episode: 2 }, DEVICE),
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
		expect(
			validateEvent({
				...createEvent(
					'tracking.added',
					'movie:603',
					{ media: SNAPSHOT, status: 'watching' },
					DEVICE
				),
				payload: { status: 'watching' } // missing media
			})
		).toBeNull();
	});
});
