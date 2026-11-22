import { describe, it, expect } from 'vitest';
import { isDbReachable } from './health';
import { createTestDb } from './db/test-db';
import type { createDb } from './db';

type Db = ReturnType<typeof createDb>;

describe('isDbReachable', () => {
	it('returns true when SELECT 1 succeeds against a real (in-memory) db', async () => {
		const db = createTestDb();
		expect(await isDbReachable(db)).toBe(true);
	});

	it('returns false and swallows the error when the query throws', async () => {
		const brokenDb = {
			run: () => Promise.reject(new Error('db down'))
		} as unknown as Db;
		expect(await isDbReachable(brokenDb)).toBe(false);
	});
});
