import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { media, mediaExternalIds } from '#lib/server/db/schema.js';
import { seedMediaId } from '#lib/sync/events.js';
import { createTestApi, installTmdbFetch, type TestApi, type TmdbStub } from '#lib/testing/http.js';
import { setTestBindings } from '#lib/server/test/cloudflare-workers.js';
import { MAX_DELIVERY_ATTEMPTS } from '#lib/server/media/refresh-consumer.js';
import type { ImdbAliasMessage } from '#lib/server/media/imdb-aliases.js';
import type { QueueEnvelope } from '#lib/server/queue/types.js';
import { POST } from './+server';

const SECRET = 'cron-secret';

let api: TestApi;
let stub: TmdbStub;

beforeEach(async () => {
	api = await createTestApi();
	stub = installTmdbFetch();
	setTestBindings({ CRON_SECRET: SECRET, TMDB_API_KEY: 'tmdb-key' });
});

afterEach(() => stub.restore());

/** A bare TMDB row: whatever the queue delivers, it must already be stored. */
async function seedMedia(externalId: string) {
	const id = seedMediaId('tmdb', externalId);
	await api.db.insert(media).values({
		id,
		provider: 'tmdb',
		externalId,
		source: 'linked',
		type: 'movie',
		title: externalId,
		version: 1,
		refreshedAt: 0
	});
	return id;
}

function deliver(messages: QueueEnvelope<ImdbAliasMessage>[]) {
	return api.call(POST, {
		method: 'POST',
		path: '/api/queue/imdb-aliases',
		headers: { 'x-cron-key': SECRET },
		body: { messages }
	});
}

async function outcomesOf(messages: QueueEnvelope<ImdbAliasMessage>[]) {
	const response = await deliver(messages);
	expect(response.status).toBe(200);
	return ((await response.json()) as { outcomes: string[] }).outcomes;
}

async function aliasesFor(mediaId: string) {
	return api.db.select().from(mediaExternalIds).where(eq(mediaExternalIds.mediaId, mediaId));
}

describe('POST /api/queue/imdb-aliases', () => {
	it('401s without a valid x-cron-key', async () => {
		const response = await api.call(POST, {
			method: 'POST',
			path: '/api/queue/imdb-aliases',
			headers: { 'x-cron-key': 'wrong' },
			body: { messages: [] }
		});
		expect(response.status).toBe(401);
	});

	it('503s without TMDB configured', async () => {
		setTestBindings({ CRON_SECRET: SECRET });
		const response = await deliver([]);
		expect(response.status).toBe(503);
	});

	it('acks every title of a healthy batch, writing the alias and stamping the row', async () => {
		const aliased = await seedMedia('movie/603');
		const withoutId = await seedMedia('movie/604');
		stub.on('/3/movie/603/external_ids', { id: 603, imdb_id: 'tt0133093' });
		stub.on('/3/movie/604/external_ids', { id: 604, imdb_id: null });

		const outcomes = await outcomesOf([
			{ body: { mediaId: aliased, provider: 'tmdb', externalId: 'movie/603' }, attempts: 1 },
			{ body: { mediaId: withoutId, provider: 'tmdb', externalId: 'movie/604' }, attempts: 1 }
		]);

		expect(outcomes).toEqual(['ack', 'ack']);
		expect(await aliasesFor(aliased)).toEqual([
			{ mediaId: aliased, provider: 'imdb', externalId: 'tt0133093' }
		]);
		expect(await aliasesFor(withoutId)).toEqual([]);
		const rows = await api.db.select().from(media);
		expect(rows.every((row) => row.imdbCheckedAt !== null)).toBe(true);
		// Stamping alone isn't client-visible, so it must not bump `version` and force a re-pull.
		expect(rows.every((row) => row.version === 1)).toBe(true);
		// The queue's job is one request per title, not a details payload.
		expect(stub.requested).toHaveLength(2);
	});

	it('retries only the title whose lookup failed, leaving it unstamped for the next run', async () => {
		const failed = await seedMedia('movie/605');
		const ok = await seedMedia('movie/606');
		stub.on('/3/movie/605/external_ids', {}, { status: 429 });
		stub.on('/3/movie/606/external_ids', { id: 606, imdb_id: 'tt0000606' });

		const outcomes = await outcomesOf([
			{ body: { mediaId: failed, provider: 'tmdb', externalId: 'movie/605' }, attempts: 1 },
			{ body: { mediaId: ok, provider: 'tmdb', externalId: 'movie/606' }, attempts: 1 }
		]);

		expect(outcomes).toEqual(['retry', 'ack']);
		const rows = new Map((await api.db.select().from(media)).map((row) => [row.id, row]));
		expect(rows.get(failed)?.imdbCheckedAt).toBeNull();
		expect(rows.get(ok)?.imdbCheckedAt).not.toBeNull();
	});

	it('stamps a title TMDB has never heard of instead of retrying it forever', async () => {
		const gone = await seedMedia('movie/1178539');
		stub.on('/3/movie/1178539/external_ids', {}, { status: 404 });

		const outcomes = await outcomesOf([
			{ body: { mediaId: gone, provider: 'tmdb', externalId: 'movie/1178539' }, attempts: 1 }
		]);

		// A 404 is an answered question: asking again tomorrow would only ever fail again.
		expect(outcomes).toEqual(['ack']);
		const [row] = await api.db.select().from(media).where(eq(media.id, gone));
		expect(row?.imdbCheckedAt).not.toBeNull();
		expect(row?.unavailableAt).not.toBeNull();
	});

	it('clears the unavailable marker (bumping version) when the title is back', async () => {
		const back = await seedMedia('movie/608');
		await api.db
			.update(media)
			.set({ unavailableAt: new Date(1_000_000_000_000) })
			.where(eq(media.id, back));
		stub.on('/3/movie/608/external_ids', { id: 608, imdb_id: 'tt0000608' });

		const outcomes = await outcomesOf([
			{ body: { mediaId: back, provider: 'tmdb', externalId: 'movie/608' }, attempts: 1 }
		]);

		// A 200 proves the entry exists again, and a client that never learns the cleared marker shows it as gone forever.
		expect(outcomes).toEqual(['ack']);
		const [row] = await api.db.select().from(media).where(eq(media.id, back));
		expect(row?.unavailableAt).toBeNull();
		expect(row?.version).toBe(2);
	});

	it('drops a title that keeps failing once the attempt cap is reached', async () => {
		const failing = await seedMedia('movie/607');
		stub.on('/3/movie/607/external_ids', {}, { status: 500 });

		const outcomes = await outcomesOf([
			{
				body: { mediaId: failing, provider: 'tmdb', externalId: 'movie/607' },
				attempts: MAX_DELIVERY_ATTEMPTS
			}
		]);

		expect(outcomes).toEqual(['ack']);
	});

	it('drops a corrupt external id without asking TMDB', async () => {
		const corrupt = await seedMedia('not-a-tmdb-id');

		const outcomes = await outcomesOf([
			{ body: { mediaId: corrupt, provider: 'tmdb', externalId: 'garbage' }, attempts: 1 }
		]);

		expect(outcomes).toEqual(['ack']);
		expect(stub.requested).toEqual([]);
	});

	// Redelivery replays the original message body, so the same title can arrive twice.
	it('is replay-safe: a delivered-twice message leaves one alias row', async () => {
		const id = await seedMedia('movie/608');
		stub.on('/3/movie/608/external_ids', { id: 608, imdb_id: 'tt0000608' });
		const message: QueueEnvelope<ImdbAliasMessage> = {
			body: { mediaId: id, provider: 'tmdb', externalId: 'movie/608' },
			attempts: 1
		};

		const outcomes = await outcomesOf([message, { ...message, attempts: 2 }]);

		expect(outcomes).toEqual(['ack', 'ack']);
		expect(await aliasesFor(id)).toHaveLength(1);
	});
});
