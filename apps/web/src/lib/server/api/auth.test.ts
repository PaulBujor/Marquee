import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '#lib/server/db/test-db.js';
import { apiTokens, users } from '#lib/server/db/schema.js';
import { generateToken, hashToken } from '#lib/server/auth/tokens.js';
import { authenticateApiToken, createApiToken } from './auth';

type Db = ReturnType<typeof createTestDb>;

let db: Db;

beforeEach(() => {
	db = createTestDb();
});

async function seedUser(email: string): Promise<string> {
	await db.insert(users).values({ email, status: 'enabled' });
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, email))
		.limit(1);
	return user.id;
}

function bearer(token: string): Request {
	return new Request('https://marquee.test/api/v1/library', {
		headers: { authorization: `Bearer ${token}` }
	});
}

describe('createApiToken', () => {
	it('returns a random secret and stores only its hash', async () => {
		const userId = await seedUser('hash@example.com');
		const { token, row } = await createApiToken(db, userId, 'laptop');

		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(row.hash).toBe(await hashToken(token));
		expect(row.hash).not.toBe(token);
		expect(row.userId).toBe(userId);
		expect(row.label).toBe('laptop');
	});

	it('leaves no copy of the plaintext anywhere in the row', async () => {
		const userId = await seedUser('plaintext@example.com');
		const { token, row } = await createApiToken(db, userId, 'laptop');

		const [stored] = await db.select().from(apiTokens).where(eq(apiTokens.id, row.id)).limit(1);
		expect(JSON.stringify(stored)).not.toContain(token);
	});
});

describe('authenticateApiToken', () => {
	it('resolves each token to the user that minted it', async () => {
		const alice = await seedUser('alice@example.com');
		const bob = await seedUser('bob@example.com');
		const aliceToken = (await createApiToken(db, alice, 'alice laptop')).token;
		const bobToken = (await createApiToken(db, bob, 'bob laptop')).token;

		expect(await authenticateApiToken(bearer(aliceToken), db)).toEqual({
			userId: alice,
			tokenId: expect.any(String),
			scopes: []
		});
		expect(await authenticateApiToken(bearer(bobToken), db)).toEqual({
			userId: bob,
			tokenId: expect.any(String),
			scopes: []
		});
	});

	it('accepts two live tokens for the same user, as distinct token ids', async () => {
		const userId = await seedUser('two@example.com');
		const first = await createApiToken(db, userId, 'phone');
		const second = await createApiToken(db, userId, 'tv');

		const a = await authenticateApiToken(bearer(first.token), db);
		const b = await authenticateApiToken(bearer(second.token), db);
		expect(a?.userId).toBe(userId);
		expect(b?.userId).toBe(userId);
		expect(a?.tokenId).not.toBe(b?.tokenId);
	});

	it('rejects an expired token', async () => {
		const userId = await seedUser('expired@example.com');
		const { token, row } = await createApiToken(db, userId, 'old');
		await db
			.update(apiTokens)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(apiTokens.id, row.id));

		expect(await authenticateApiToken(bearer(token), db)).toBeNull();
	});

	it('rejects a revoked token', async () => {
		const userId = await seedUser('revoked@example.com');
		const { token, row } = await createApiToken(db, userId, 'revoked');
		await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, row.id));

		expect(await authenticateApiToken(bearer(token), db)).toBeNull();
	});

	it('rejects an unknown token', async () => {
		await seedUser('unknown@example.com');
		expect(await authenticateApiToken(bearer(generateToken()), db)).toBeNull();
	});

	it.each([
		['no header', undefined],
		['an empty header', ''],
		['the scheme alone', 'Bearer'],
		['a blank token', 'Bearer '],
		['another scheme', `Basic ${generateToken()}`],
		['a token with illegal characters', 'Bearer not a token!']
	])('rejects %s', async (_case, header) => {
		await seedUser('malformed@example.com');
		const request = new Request('https://marquee.test/api/v1/library', {
			headers: header === undefined ? {} : { authorization: header }
		});

		expect(await authenticateApiToken(request, db)).toBeNull();
	});

	it('leaves lastUsedAt alone, so authenticating is a pure read', async () => {
		const userId = await seedUser('readonly@example.com');
		const { token, row } = await createApiToken(db, userId, 'read');

		await authenticateApiToken(bearer(token), db);

		const [after] = await db.select().from(apiTokens).where(eq(apiTokens.id, row.id)).limit(1);
		expect(after.lastUsedAt).toBeNull();
	});

	it('stops authenticating once the account is deleted', async () => {
		const userId = await seedUser('gone@example.com');
		const { token } = await createApiToken(db, userId, 'laptop');

		await db.delete(users).where(eq(users.id, userId));

		expect(await db.select().from(apiTokens)).toHaveLength(0);
		expect(await authenticateApiToken(bearer(token), db)).toBeNull();
	});
});
