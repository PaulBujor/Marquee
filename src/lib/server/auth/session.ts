import type { Cookies } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { createDb } from '$lib/server/db';
import { sessions, users, type Session, type User } from '$lib/server/db/schema';
import { generateToken, hashToken } from './tokens';

type Db = ReturnType<typeof createDb>;

export const SESSION_COOKIE = 'session';

/** Sessions live 30 days; each authenticated request slides the expiry forward. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Refresh `lastUsedAt`/expiry at most once per day to avoid a write per request. */
const SESSION_REFRESH_MS = 24 * 60 * 60 * 1000;

/**
 * Mint a new session for a user. Returns the raw token to place in the cookie;
 * only its hash is stored server-side.
 */
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

/**
 * Resolve a session cookie value to its user, or null if missing/expired.
 * Expired sessions are deleted; valid ones have their expiry slid forward
 * (throttled to once per day).
 */
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
	if (row.session.expiresAt.getTime() <= now) {
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

/** Delete a session by its cookie token (used on logout). */
export async function invalidateSession(db: Db, token: string): Promise<void> {
	await db.delete(sessions).where(eq(sessions.id, await hashToken(token)));
}

export function setSessionCookie(cookies: Cookies, token: string, expiresAt: Date): void {
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: true,
		expires: expiresAt
	});
}

export function deleteSessionCookie(cookies: Cookies): void {
	cookies.delete(SESSION_COOKIE, { path: '/' });
}
