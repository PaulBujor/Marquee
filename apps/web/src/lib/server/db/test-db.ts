import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import type { createDb } from './index';

type Db = ReturnType<typeof createDb>;

/** In-memory SQLite with the real migrations applied, typed as the D1-backed `Db`; tests only. */
export function createTestDb(): Db {
	const sqlite = new Database(':memory:');
	const dir = join(process.cwd(), 'drizzle');
	const files = readdirSync(dir)
		.filter((f) => f.endsWith('.sql'))
		.sort();
	for (const file of files) {
		// `--> statement-breakpoint` is a `--` comment, so the migration (incl. the trigger) runs as one script.
		sqlite.exec(readFileSync(join(dir, file), 'utf8'));
	}

	const db = drizzle(sqlite, { schema });
	// better-sqlite3 has no db.batch(), so shim it with a real transaction to keep D1's all-or-nothing guarantee.
	(db as unknown as { batch: (queries: PromiseLike<unknown>[]) => Promise<unknown[]> }).batch =
		async (queries) => {
			sqlite.exec('BEGIN');
			try {
				const results: unknown[] = [];
				for (const query of queries) results.push(await query);
				sqlite.exec('COMMIT');
				return results;
			} catch (err) {
				sqlite.exec('ROLLBACK');
				throw err;
			}
		};
	return db as unknown as Db;
}
