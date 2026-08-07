import { afterEach, describe, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { createTestDb } from '$lib/server/db/test-db';
import { media } from '$lib/server/db/schema';
import { mediaId } from '$lib/sync/events';
import { POST } from './+server';

type Handler = typeof POST;
type RequestEvent = Parameters<Handler>[0];

const SECRET = 'cron-secret';

function makeEvent(opts: {
	db?: ReturnType<typeof createTestDb>;
	header?: string | null;
	apiKey?: string | null;
	body?: unknown;
}): RequestEvent {
	const { db, header = SECRET, apiKey = 'tmdb-key', body = { messages: [] } } = opts;
	const request = {
		headers: { get: (name: string) => (name === 'x-cron-key' ? header : null) },
		json: async () => body
	};
	const platform = {
		env: { CRON_SECRET: SECRET, ...(apiKey === null ? {} : { TMDB_API_KEY: apiKey }) }
	};
	return { request, locals: { db }, platform } as unknown as RequestEvent;
}

async function thrownBy(run: () => unknown): Promise<{ status: number }> {
	try {
		await run();
		throw new Error('expected the handler to throw');
	} catch (err) {
		return err as { status: number };
	}
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('POST /api/queue/media-refresh', () => {
	it('401s without a valid x-cron-key', async () => {
		const err = await thrownBy(() => POST(makeEvent({ header: 'wrong' })));
		expect(isHttpError(err)).toBe(true);
		expect(err.status).toBe(401);
	});

	it('503s without a db', async () => {
		const err = await thrownBy(() => POST(makeEvent({ db: undefined })));
		expect(err.status).toBe(503);
	});

	it('503s without TMDB_API_KEY configured', async () => {
		const err = await thrownBy(() => POST(makeEvent({ db: createTestDb(), apiKey: null })));
		expect(err.status).toBe(503);
	});

	it('processes each message and returns one outcome per message, in order', async () => {
		const db = createTestDb();
		await db.insert(media).values({
			id: mediaId('tmdb', 'show/1'),
			provider: 'tmdb',
			externalId: 'show/1',
			source: 'linked',
			type: 'show',
			title: 'show/1',
			inProduction: true,
			version: 1,
			refreshedAt: 0
		});
		const fetchSpy = vi.fn(async (input: URL | string) => {
			const path = new URL(String(input)).pathname;
			if (/\/season\/\d+$/.test(path)) {
				return new Response(JSON.stringify({ season_number: 1, name: 'S1', episodes: [] }));
			}
			return new Response(
				JSON.stringify({
					id: 1,
					name: 'title',
					first_air_date: '2026-01-01',
					status: 'Returning Series',
					in_production: true,
					seasons: [{ season_number: 1, name: 'S1', episode_count: 1 }]
				})
			);
		});
		vi.stubGlobal('fetch', fetchSpy);

		const res = await POST(
			makeEvent({
				db,
				body: { messages: [{ body: { provider: 'tmdb', externalId: 'show/1' }, attempts: 1 }] }
			})
		);
		const result = (await res.json()) as { outcomes: string[] };

		expect(result.outcomes).toEqual(['ack']);
	});
});
