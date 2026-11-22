# Down migrations (manual rollback)

Drizzle-kit and `wrangler d1 migrations apply` are **up-only** — there is no
automatic `down`. These hand-written scripts reverse each committed migration in
`../` and are kept in lockstep with it: **edit the matching `*.down.sql` whenever
you change or add an up migration.**

Each file `NNNN_<name>.down.sql` exactly reverses `drizzle/NNNN_<name>.sql`.
Unlike the up migrations, these are plain SQL (no `--> statement-breakpoint`
markers) so they run directly through `wrangler d1 execute`.

## Applying a rollback

```bash
# roll back the latest migration on the preview DB
pnpm exec wrangler d1 execute marquee-preview --remote \
  --file drizzle/down/0004_sync_event_model.down.sql

# local D1
pnpm exec wrangler d1 execute marquee --local \
  --file drizzle/down/0004_sync_event_model.down.sql
```

To roll back multiple migrations, run them newest-first (0004 → 0003 → …).

## Migration ledger

`wrangler` tracks applied up migrations in the `d1_migrations` table; these down
scripts do **not** touch it. After rolling back, delete the corresponding
ledger row(s) so the up migration re-applies on the next `migrations apply`:

```sql
DELETE FROM d1_migrations WHERE name = '0004_sync_event_model.sql';
```

(Confirm the exact `name` with `SELECT name FROM d1_migrations;` first.)
