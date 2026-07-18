import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import type { createDb } from './index';

type Db = ReturnType<typeof createDb>;

/**
 * An in-memory SQLite database with all committed Drizzle migrations applied,
 * typed as the app's D1-backed `Db`. For unit tests only: D1's SQL dialect is
 * SQLite, so this exercises the real schema, migrations and `updated_at`
 * trigger. (The cast bridges the better-sqlite3 driver to the D1 driver type —
 * the query surface the auth code uses is identical across both.)
 */
export function createTestDb(): Db {
	const sqlite = new Database(':memory:');
	const dir = join(process.cwd(), 'drizzle');
	const files = readdirSync(dir)
		.filter((f) => f.endsWith('.sql'))
		.sort();
	for (const file of files) {
		// `--> statement-breakpoint` markers are `--` line comments, so the whole
		// migration (incl. the BEGIN...END trigger) runs as one script.
		sqlite.exec(readFileSync(join(dir, file), 'utf8'));
	}
	return drizzle(sqlite, { schema }) as unknown as Db;
}
