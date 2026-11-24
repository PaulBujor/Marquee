import { and, desc, eq, isNull } from 'drizzle-orm';
import type { createDb } from '#lib/server/db/index.js';
import { apiTokens, type ApiToken } from '#lib/server/db/schema.js';

type Db = ReturnType<typeof createDb>;

/** Label bound shared with the settings card's input. */
export const API_TOKEN_LABEL_MAX = 60;

/** Last four characters of the row id — enough to tell tokens apart in the UI, never the secret. */
const HINT_LENGTH = 4;

/** The row's id is the handle the settings card revokes by; the hash never leaves the server. */
export type ApiTokenRow = Omit<ApiToken, 'hash' | 'userId'>;

export interface ApiTokenSummary {
	id: string;
	hint: string;
	label: string;
	scopes: string[];
	createdAt: number;
	lastUsedAt: number | null;
	expiresAt: number | null;
	revokedAt: number | null;
}

export function toApiTokenSummary(row: ApiTokenRow): ApiTokenSummary {
	return {
		id: row.id,
		hint: row.id.slice(-HINT_LENGTH),
		label: row.label,
		scopes: row.scopes,
		createdAt: row.createdAt.getTime(),
		lastUsedAt: row.lastUsedAt?.getTime() ?? null,
		expiresAt: row.expiresAt?.getTime() ?? null,
		revokedAt: row.revokedAt?.getTime() ?? null
	};
}

/** The caller's own tokens only, newest first. */
export async function listApiTokens(db: Db, userId: string): Promise<ApiTokenSummary[]> {
	const rows = await db
		.select({
			id: apiTokens.id,
			label: apiTokens.label,
			scopes: apiTokens.scopes,
			createdAt: apiTokens.createdAt,
			lastUsedAt: apiTokens.lastUsedAt,
			expiresAt: apiTokens.expiresAt,
			revokedAt: apiTokens.revokedAt
		})
		.from(apiTokens)
		.where(eq(apiTokens.userId, userId))
		.orderBy(desc(apiTokens.createdAt));
	return rows.map(toApiTokenSummary);
}

/** Revoking is once-only: a second call updates nothing, so it reads as a 404 rather than a silent no-op. */
export async function revokeApiToken(
	db: Db,
	userId: string,
	id: string
): Promise<ApiTokenSummary | null> {
	const [row] = await db
		.update(apiTokens)
		.set({ revokedAt: new Date() })
		.where(and(eq(apiTokens.userId, userId), eq(apiTokens.id, id), isNull(apiTokens.revokedAt)))
		.returning();
	return row ? toApiTokenSummary(row) : null;
}
