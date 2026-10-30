import type { Cookies } from '@sveltejs/kit';
import { and, eq, ne } from 'drizzle-orm';
import type { createDb } from '#lib/server/db/index.js';
import { sessions, users, type Session, type User } from '#lib/server/db/schema.js';
import { generateToken, hashToken } from './tokens';

type Db = ReturnType<typeof createDb>;

export const SESSION_COOKIE = 'session';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Refresh `lastUsedAt`/expiry at most once per day to avoid a write per request. */
const SESSION_REFRESH_MS = 24 * 60 * 60 * 1000;

/** Returns the raw token for the cookie; only its hash is stored. */
export async function createSession(
	db: Db,
	userId: string
): Promise<{ token: string; expiresAt: Date }> {
	const token = generateToken();
	const id = await hashToken(token);
	const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
	await db.insert(sessions).values({ id, userId, expiresAt });
	return { token, expiresAt };
}

export async function validateSession(
	db: Db,
	token: string
): Promise<{ user: User; session: Session } | null> {
	const id = await hashToken(token);
	const rows = await db
		.select({ session: sessions, user: users })
		.from(sessions)
		.innerJoin(users, eq(sessions.userId, users.id))
		.where(eq(sessions.id, id))
		.limit(1);

	const row = rows.at(0);
	if (!row) return null;

	const now = Date.now();
	// A user blocked after signing in must lose their session on the next request.
	if (row.session.expiresAt.getTime() <= now || row.user.status !== 'enabled') {
		await db.delete(sessions).where(eq(sessions.id, id));
		return null;
	}

	if (now - row.session.lastUsedAt.getTime() > SESSION_REFRESH_MS) {
		const lastUsedAt = new Date(now);
		const expiresAt = new Date(now + SESSION_TTL_MS);
		await db.update(sessions).set({ lastUsedAt, expiresAt }).where(eq(sessions.id, id));
		row.session.lastUsedAt = lastUsedAt;
		row.session.expiresAt = expiresAt;
	}

	return row;
}

export async function invalidateSession(db: Db, token: string): Promise<void> {
	await db.delete(sessions).where(eq(sessions.id, await hashToken(token)));
}

/** Sign-in is keyed on email, so changing it revokes every other session; `keepToken` spares the caller's own. */
export async function invalidateOtherSessions(
	db: Db,
	userId: string,
	keepToken: string | null
): Promise<number> {
	const keepId = keepToken ? await hashToken(keepToken) : null;
	const deleted = await db
		.delete(sessions)
		.where(
			keepId
				? and(eq(sessions.userId, userId), ne(sessions.id, keepId))
				: eq(sessions.userId, userId)
		)
		.returning({ id: sessions.id });
	return deleted.length;
}

/** Preview-only, where every host shares one database; production stays host-only by passing nothing. */
export function setSessionCookie(
	cookies: Cookies,
	token: string,
	expiresAt: Date,
	domain?: string
): void {
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: true,
		expires: expiresAt,
		...(domain ? { domain } : {})
	});
}

export function deleteSessionCookie(cookies: Cookies, domain?: string): void {
	cookies.delete(SESSION_COOKIE, { path: '/', ...(domain ? { domain } : {}) });
}
