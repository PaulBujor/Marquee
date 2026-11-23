import { beforeEach, describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { createTestDb } from '#lib/server/db/test-db.js';
import { apiTokens, users } from '#lib/server/db/schema.js';
import { authenticateApiToken, createApiToken } from '#lib/server/api/auth.js';
import { GET, POST } from './+server';
import { DELETE } from './[id]/+server';

type Db = ReturnType<typeof createTestDb>;

const ALICE = 'user-alice';
const BOB = 'user-bob';

let db: Db;

beforeEach(async () => {
	db = createTestDb();
	await db.insert(users).values({ id: ALICE, email: 'alice@example.com', status: 'enabled' });
	await db.insert(users).values({ id: BOB, email: 'bob@example.com', status: 'enabled' });
});

function bearer(token: string): Request {
	return new Request('https://marquee.test/api/v1/library', {
		headers: { authorization: `Bearer ${token}` }
	});
}

async function statusOf(run: () => unknown): Promise<number> {
	try {
		const res = (await run()) as Response;
		return res.status;
	} catch (err) {
		if (isHttpError(err)) return err.status;
		throw err;
	}
}

function getEvent(user: { id: string } | null, database: Db | null = db) {
	return { locals: { db: database, user } } as unknown as Parameters<typeof GET>[0];
}

function postEvent(user: { id: string } | null, body: unknown, database: Db | null = db) {
	const request = new Request('https://marquee.test/api/tokens', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	return { locals: { db: database, user }, request } as unknown as Parameters<typeof POST>[0];
}

function deleteEvent(user: { id: string } | null, id: string, database: Db | null = db) {
	return {
		locals: { db: database, user },
		params: { id }
	} as unknown as Parameters<typeof DELETE>[0];
}

async function listFor(user: { id: string }): Promise<{ tokens: Record<string, unknown>[] }> {
	const res = await GET(getEvent(user));
	return (await res.json()) as { tokens: Record<string, unknown>[] };
}

describe('GET /api/tokens', () => {
	it('401s unauthenticated and 503s without a db', async () => {
		expect(await statusOf(() => GET(getEvent(null)))).toBe(401);
		expect(await statusOf(() => GET(getEvent({ id: ALICE }, null)))).toBe(503);
	});

	it("returns only the caller's tokens and never the hash", async () => {
		const alice = await createApiToken(db, ALICE, 'alice laptop');
		const bob = await createApiToken(db, BOB, 'bob laptop');

		const { tokens } = await listFor({ id: ALICE });

		expect(tokens).toHaveLength(1);
		expect(tokens[0]).toMatchObject({
			id: alice.row.id,
			label: 'alice laptop',
			hint: alice.row.id.slice(-4),
			scopes: []
		});
		expect(tokens[0]).not.toHaveProperty('hash');
		expect(JSON.stringify(tokens)).not.toContain(alice.token);
		expect(JSON.stringify(tokens)).not.toContain(bob.row.id);
	});
});

describe('POST /api/tokens', () => {
	it('401s unauthenticated and 503s without a db', async () => {
		expect(await statusOf(() => POST(postEvent(null, { label: 'x' })))).toBe(401);
		expect(await statusOf(() => POST(postEvent({ id: ALICE }, { label: 'x' }, null)))).toBe(503);
	});

	it('400s a missing or empty label', async () => {
		expect(await statusOf(() => POST(postEvent({ id: ALICE }, {})))).toBe(400);
		expect(await statusOf(() => POST(postEvent({ id: ALICE }, { label: '   ' })))).toBe(400);
	});

	it('returns the plaintext once and it authenticates as the caller', async () => {
		const res = await POST(postEvent({ id: ALICE }, { label: 'laptop' }));
		expect(res.status).toBe(201);

		const body = (await res.json()) as Record<string, unknown>;
		expect(body.token).toMatch(/^mqr_[A-Za-z0-9_-]{43}$/);
		expect(body).not.toHaveProperty('hash');
		expect(body.label).toBe('laptop');

		expect(await authenticateApiToken(bearer(body.token as string), db)).toEqual({
			userId: ALICE,
			tokenId: body.id,
			scopes: []
		});
	});

	it('binds the new token to the caller only', async () => {
		await POST(postEvent({ id: ALICE }, { label: 'alice' }));
		const bob = await createApiToken(db, BOB, 'bob');

		const { tokens } = await listFor({ id: BOB });
		expect(tokens.map((t) => t.id)).toEqual([bob.row.id]);
	});
});

describe('DELETE /api/tokens/[id]', () => {
	it('401s unauthenticated and 503s without a db', async () => {
		expect(await statusOf(() => DELETE(deleteEvent(null, 'id')))).toBe(401);
		expect(await statusOf(() => DELETE(deleteEvent({ id: ALICE }, 'id', null)))).toBe(503);
	});

	it('revokes the caller-owned token immediately and keeps the row as an audit trail', async () => {
		const { token, row } = await createApiToken(db, ALICE, 'laptop');
		expect(await authenticateApiToken(bearer(token), db)).not.toBeNull();

		const res = await DELETE(deleteEvent({ id: ALICE }, row.id));
		expect(res.status).toBe(200);

		expect(await authenticateApiToken(bearer(token), db)).toBeNull();
		const [stored] = await db.select().from(apiTokens).where(eq(apiTokens.id, row.id));
		expect(stored).toBeDefined();
		expect(stored.revokedAt).not.toBeNull();
	});

	it("404s for another user's token and leaves it authenticating", async () => {
		const { token, row } = await createApiToken(db, BOB, 'bob laptop');

		expect(await statusOf(() => DELETE(deleteEvent({ id: ALICE }, row.id)))).toBe(404);
		expect(await authenticateApiToken(bearer(token), db)).not.toBeNull();
	});

	it('404s for a non-existent id and for an already-revoked token', async () => {
		expect(await statusOf(() => DELETE(deleteEvent({ id: ALICE }, 'no-such-id')))).toBe(404);

		const { row } = await createApiToken(db, ALICE, 'once');
		expect(await statusOf(() => DELETE(deleteEvent({ id: ALICE }, row.id)))).toBe(200);
		expect(await statusOf(() => DELETE(deleteEvent({ id: ALICE }, row.id)))).toBe(404);
	});
});
