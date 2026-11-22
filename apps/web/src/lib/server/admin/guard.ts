import { error } from '@sveltejs/kit';
import type { User } from '#lib/server/db/schema.js';

// `/administrator` must not match. Enforced in the hook, so endpoint and `__data.json` fetches are gated too; a layout guard never sees those.
export function isAdminPath(pathname: string): boolean {
	return pathname === '/admin' || pathname.startsWith('/admin/');
}

// 404, not 403 — a 403 would confirm an admin surface exists. Call it from actions too: one can be POSTed without a page visit.
export function requireAdmin(user: User | null): User {
	if (!user || user.role !== 'admin') error(404, 'Not found');
	return user;
}
