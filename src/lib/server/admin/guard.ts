import { error } from '@sveltejs/kit';
import type { User } from '#lib/server/db/schema.js';

/**
 * True for the admin surface and nothing else — `/administrator` must not match. Used by the hook, so that
 * endpoints and the client's `__data.json` fetches are gated too; a layout guard alone never sees those.
 */
export function isAdminPath(pathname: string): boolean {
	return pathname === '/admin' || pathname.startsWith('/admin/');
}

/**
 * A non-admin gets 404, not 403 — a 403 would confirm an admin surface exists. Call it from the admin
 * layout *and* again inside every action, because an action can be POSTed without visiting a page.
 */
export function requireAdmin(user: User | null): User {
	if (!user || user.role !== 'admin') error(404, 'Not found');
	return user;
}
