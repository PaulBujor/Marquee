import { describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import type { User } from '#lib/server/db/schema.js';
import { isAdminPath, requireAdmin } from './guard.js';

function makeUser(role: 'user' | 'admin'): User {
	return {
		id: 'user-1',
		email: 'person@example.com',
		status: 'enabled',
		role,
		blockedReason: null,
		deletedAt: null,
		signupIp: null,
		createdAt: new Date(),
		updatedAt: new Date()
	};
}

function statusOf(fn: () => unknown): number | undefined {
	try {
		fn();
		return undefined;
	} catch (err) {
		if (isHttpError(err)) return err.status;
		throw err;
	}
}

describe('isAdminPath', () => {
	it('covers the surface, its children and its data requests', () => {
		for (const path of [
			'/admin',
			'/admin/',
			'/admin/users',
			'/admin/users/__data.json',
			'/admin/api/x'
		]) {
			expect(isAdminPath(path)).toBe(true);
		}
	});

	it('does not swallow lookalike routes', () => {
		for (const path of ['/', '/administrator', '/adminstration', '/api/admin']) {
			expect(isAdminPath(path)).toBe(false);
		}
	});
});

describe('requireAdmin', () => {
	it('hides the surface from an anonymous caller', () => {
		expect(statusOf(() => requireAdmin(null))).toBe(404);
	});

	it('hides the surface from a signed-in non-admin', () => {
		expect(statusOf(() => requireAdmin(makeUser('user')))).toBe(404);
	});

	it('returns the admin', () => {
		const admin = makeUser('admin');
		expect(requireAdmin(admin)).toBe(admin);
	});
});
