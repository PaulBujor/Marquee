# Marquee — Agent Instructions

Movie & TV tracking PWA. Linear team board (MRQ): https://linear.app/paulbujor/team/MRQ — Core App project: https://linear.app/paulbujor/project/marquee-fad148833ffe

## Reference

- `reference/watchlist-ui-concept.jsx` — throwaway React mockup for UI/UX reference (carries `data-spec-ref` attributes)

## Tech stack

- **SvelteKit** (Svelte 5, runes mode)
- **Cloudflare** deployment via `adapter-cloudflare` — NOT `adapter-cloudflare-workers` (deprecated)
- **D1** (SQLite) via Drizzle ORM (`drizzle-orm/d1`) in `src/lib/server/db`
- **Tailwind CSS v4** with `@tailwindcss/vite` plugin
- **shadcn-svelte** + Bits UI for component library
- **Resend** for transactional email; **Mailpit** (Docker) for local dev
- **TMDB API** for media metadata
- **IndexedDB** for client-side offline storage
- **Web Push (VAPID)** for notifications

## Setup

The project is already scaffolded — see README "Getting started" for the clone-based setup (`git clone` → `npm install` → `.dev.vars` → `wrangler d1 create marquee` → `npm run db:push` → `npm run dev`). It was bootstrapped with the official `sv` CLI (`sv create`, `sv add sveltekit-adapter/tailwindcss/drizzle/eslint prettier`, `shadcn-svelte init`); do NOT re-scaffold.

Wrangler config (`wrangler.jsonc`) invariants to preserve:

- `compatibility_flags: ["nodejs_compat"]` (required for D1, crypto, nodemailer)
- D1 binding named `DB`
- Deploy target is **Workers Static Assets** (`main` + `assets.directory`), NOT Cloudflare Pages (Pages is being absorbed into Workers; Cron Triggers are Workers-only). Uses `@sveltejs/adapter-cloudflare`, not the deprecated `adapter-cloudflare-workers`.

## Commands

| Task                       | Command                                           |
| -------------------------- | ------------------------------------------------- |
| Dev server                 | `npm run dev`                                     |
| Build                      | `npm run build` (runs `wrangler types` first)     |
| Preview (built worker)     | `npm run preview` (`wrangler dev`)                |
| Deploy                     | `wrangler deploy`                                 |
| Lint                       | `npm run lint` (`prettier --check` + eslint)      |
| Typecheck                  | `npm run check` (`wrangler types` + svelte-check) |
| Format                     | `npm run format`                                  |
| Regen worker types         | `npm run gen` (`wrangler types`)                  |
| Drizzle generate migration | `npm run db:generate`                             |
| Drizzle push schema (dev)  | `npm run db:push`                                 |
| Drizzle apply migrations   | `npm run db:migrate`                              |
| Drizzle Studio             | `npm run db:studio`                               |

Run `lint → typecheck → build` (`npm run lint && npm run check && npm run build`) before pushing — this mirrors CI (`.github/workflows/ci.yml`, Node 22).

## Architecture

- **Server-only code** lives in `src/lib/server/` and must never be imported from client code. `src/hooks.server.ts` creates a per-request Drizzle client — `event.locals.db = createDb(platform.env.DB)` (guarded by `event.platform`, typed via `App.Locals` in `src/app.d.ts`).
- **Database**: Cloudflare D1 (binding `DB`) via Drizzle (`drizzle-orm/d1`). Schema at `src/lib/server/db/schema.ts`, `createDb()` at `src/lib/server/db/index.ts`. `drizzle.config.ts` uses the `sqlite` dialect; migrations output to `./drizzle`. ⚠️ The schema is still the scaffold demo `task` table — the real watchlist model is not built yet.
- **Email**: `EmailSender` interface (`src/lib/server/email/index.ts`) with `ResendSender` (prod) and `SmtpSender` (dev, nodemailer → Mailpit).
- **Theme / design tokens**: dark mode is a `.dark` class on `<html>`, toggled reactively by the `theme` rune singleton (`src/lib/state/theme.svelte.ts`, persisted to `localStorage` key `marquee:theme-mode`) in `src/routes/+layout.svelte`. Tokens are oklch CSS variables in `src/routes/layout.css` mapped to Tailwind via `@theme inline` — there is **no `tailwind.config`** (Tailwind v4, CSS-configured). shadcn-svelte style is `nova`; component/util/ui aliases live in `components.json`.
- **PWA / offline**: `src/service-worker.ts` (cache-first), manifest + icons in `static/`. Planned client offline state is IndexedDB with a materialized-state layer.
- **Event-sourced sync** (planned): Offline & Sync is sequenced before the higher feature epics — all tracking writes are intended to flow through the event pipeline from the start.
- **Auth** (planned): passwordless magic link → verify endpoint → httpOnly session cookie; `hooks.server.ts` will validate the session cookie on every request.

## Roadmap / build order

Tracked in Linear team **MRQ**. Rough sequence, from the current UI foundation outward: magic-link auth → event-sourced offline sync → TMDB API client → tracking/watchlist model. Later projects (all in backlog): **Timeline View** (upcoming releases), **Custom Media & Linking** (niche titles not on TMDB), **Data Portability** (JSON export), **Notifications** (Web Push / VAPID / daily cron sweep), **Recommendations Engine** (multi-cluster taste profiles). Check the team board for current issue detail rather than assuming from this list.

## Testing

No test framework is configured yet — there is no `test` script and no vitest/playwright dependency. Do not assume tests exist; if adding them, wire the runner into `package.json` and CI.

## Secrets

- `.dev.vars` for local Wrangler secrets (TMDB_API_KEY, RESEND_API_KEY, VAPID keys)
- `wrangler secret put <NAME>` for production
- Never commit `.dev.vars` — already in `.gitignore`

## Linear

- Team **MRQ** (https://linear.app/paulbujor/team/MRQ). Issue IDs are `MRQ-<n>`.
- Reference the issue in branch names: `paul/mrq-<n>-short-slug`.
