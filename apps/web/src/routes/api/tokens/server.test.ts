import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApi, type TestApi } from '#lib/testing/http.js';
import { apiTokens } from '#lib/server/db/schema.js';
import { GET as LIBRARY_GET } from '../v1/library/+server';
import { GET, POST } from './+server';
import { DELETE } from './[id]/+server';

const ALICE = 'user-alice';
const BOB = 'user-bob';

let api: TestApi;

beforeEach(async () => {
	api = await createTestApi();
});

async function listFor(userId: string): Promise<{ tokens: Record<string, unknown>[] }> {
	const res = await api.call(GET, { path: '/api/tokens', user: { id: userId } });
	expect(res.status).toBe(200);
	return (await res.json()) as { tokens: Record<string, unknown>[] };
}

/** Proves a token works through the external API, which reads its identity from the bearer alone. */
async function libraryStatus(token: string): Promise<number> {
	return (await api.call(LIBRARY_GET, { path: '/api/v1/library', token })).status;
}

describe('GET /api/tokens', () => {
	it('401s unauthenticated and 503s without a db', async () => {
		expect((await api.call(GET, { path: '/api/tokens' })).status).toBe(401);
		expect(
			(await api.call(GET, { path: '/api/tokens', user: { id: ALICE }, db: null })).status
		).toBe(503);
	});

	it("returns only the caller's tokens and never the hash", async () => {
		const { tokens } = await listFor(ALICE);

		expect(tokens).toHaveLength(1);
		expect(tokens[0]).toMatchObject({
			id: api.alice.row.id,
			label: api.alice.row.label,
			hint: api.alice.row.id.slice(-4),
			scopes: []
		});
		expect(tokens[0]).not.toHaveProperty('hash');
		expect(JSON.stringify(tokens)).not.toContain(api.alice.token);
		expect(JSON.stringify(tokens)).not.toContain(api.bob.row.id);
	});
});

describe('POST /api/tokens', () => {
	it('401s unauthenticated and 503s without a db', async () => {
		expect(
			(await api.call(POST, { path: '/api/tokens', method: 'POST', body: { label: 'x' } })).status
		).toBe(401);
		expect(
			(
				await api.call(POST, {
					path: '/api/tokens',
					method: 'POST',
					user: { id: ALICE },
					body: { label: 'x' },
					db: null
				})
			).status
		).toBe(503);
	});

	it('401s a bearer token without a session: the management API is session-authenticated', async () => {
		const res = await api.call(POST, {
			path: '/api/tokens',
			method: 'POST',
			token: api.alice.token,
			body: { label: 'x' }
		});

		expect(res.status).toBe(401);
	});

	it('400s a missing or empty label', async () => {
		for (const body of [{}, { label: '   ' }]) {
			const res = await api.call(POST, {
				path: '/api/tokens',
				method: 'POST',
				user: { id: ALICE },
				body
			});
			expect(res.status).toBe(400);
		}
	});

	it('returns the plaintext once and it authenticates as the caller', async () => {
		const res = await api.call(POST, {
			path: '/api/tokens',
			method: 'POST',
			user: { id: ALICE },
			body: { label: 'laptop' }
		});
		expect(res.status).toBe(201);

		const body = (await res.json()) as Record<string, unknown>;
		expect(body.token).toMatch(/^mqr_[A-Za-z0-9_-]{43}$/);
		expect(body).not.toHaveProperty('hash');
		expect(body.label).toBe('laptop');

		expect(await libraryStatus(body.token as string)).toBe(200);
	});

	it('binds the new token to the caller only', async () => {
		await api.call(POST, {
			path: '/api/tokens',
			method: 'POST',
			user: { id: ALICE },
			body: { label: 'alice' }
		});

		const { tokens } = await listFor(BOB);
		expect(tokens.map((t) => t.id)).toEqual([api.bob.row.id]);
	});
});

describe('DELETE /api/tokens/[id]', () => {
	it('401s unauthenticated and 503s without a db', async () => {
		expect(
			(await api.call(DELETE, { path: '/api/tokens/x', method: 'DELETE', params: { id: 'x' } }))
				.status
		).toBe(401);
		expect(
			(
				await api.call(DELETE, {
					path: '/api/tokens/x',
					method: 'DELETE',
					user: { id: ALICE },
					params: { id: 'x' },
					db: null
				})
			).status
		).toBe(503);
	});

	it('revokes the caller-owned token immediately and keeps the row as an audit trail', async () => {
		expect(await libraryStatus(api.alice.token)).toBe(200);

		const res = await api.call(DELETE, {
			path: `/api/tokens/${api.alice.row.id}`,
			method: 'DELETE',
			user: { id: ALICE },
			params: { id: api.alice.row.id }
		});
		expect(res.status).toBe(200);

		expect(await libraryStatus(api.alice.token)).toBe(401);
		const [stored] = await api.db
			.select()
			.from(apiTokens)
			.where(eq(apiTokens.id, api.alice.row.id));
		expect(stored).toBeDefined();
		expect(stored.revokedAt).not.toBeNull();
	});

	it("404s for another user's token and leaves it authenticating", async () => {
		const res = await api.call(DELETE, {
			path: `/api/tokens/${api.bob.row.id}`,
			method: 'DELETE',
			user: { id: ALICE },
			params: { id: api.bob.row.id }
		});

		expect(res.status).toBe(404);
		expect(await libraryStatus(api.bob.token)).toBe(200);
	});

	it('404s for a non-existent id and for an already-revoked token', async () => {
		const revoke = (id: string) =>
			api.call(DELETE, {
				path: `/api/tokens/${id}`,
				method: 'DELETE',
				user: { id: ALICE },
				params: { id }
			});

		expect((await revoke('no-such-id')).status).toBe(404);
		expect((await revoke(api.alice.row.id)).status).toBe(200);
		expect((await revoke(api.alice.row.id)).status).toBe(404);
	});
});
