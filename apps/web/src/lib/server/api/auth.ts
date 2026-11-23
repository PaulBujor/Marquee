import { eq } from 'drizzle-orm';
import type { createDb } from '#lib/server/db/index.js';
import { apiTokens, type ApiToken } from '#lib/server/db/schema.js';
import { generateToken, hashToken } from '#lib/server/auth/tokens.js';

type Db = ReturnType<typeof createDb>;

export interface ApiTokenIdentity {
	userId: string;
	tokenId: string;
	scopes: string[];
}

const BEARER = /^Bearer +([A-Za-z0-9_-]+)$/i;

/** Identifies the secret in logs and secret scanners; not a security boundary. */
const TOKEN_PREFIX = 'mqr_';

/** Returns the plaintext token itself, once; only its hash is stored. */
export async function createApiToken(
	db: Db,
	userId: string,
	label: string
): Promise<{ token: string; row: ApiToken }> {
	const token = TOKEN_PREFIX + generateToken();
	const [row] = await db
		.insert(apiTokens)
		.values({ userId, label, hash: await hashToken(token), scopes: [] })
		.returning();
	return { token, row };
}

/**
 * The whole auth boundary for the external API: the caller's identity is read from the token row and
 * nothing else, and every rejection is the same `null` so a caller can't probe which tokens exist.
 */
export async function authenticateApiToken(
	request: Request,
	db: Db
): Promise<ApiTokenIdentity | null> {
	const match = BEARER.exec(request.headers.get('authorization') ?? '');
	if (!match) return null;

	const [row] = await db
		.select({
			id: apiTokens.id,
			userId: apiTokens.userId,
			scopes: apiTokens.scopes,
			expiresAt: apiTokens.expiresAt,
			revokedAt: apiTokens.revokedAt
		})
		.from(apiTokens)
		.where(eq(apiTokens.hash, await hashToken(match[1])))
		.limit(1);

	if (!row || row.revokedAt !== null) return null;
	if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) return null;

	return { userId: row.userId, tokenId: row.id, scopes: row.scopes };
}
