# Marquee — Agent Instructions

Movie & TV tracking PWA. Linear project: https://linear.app/paulbujor/project/marquee-fad148833ffe

## Reference

- `reference/watchlist-spec.md` — full product & technical spec (data model, auth flow, sync architecture, epics)
- `reference/watchlist-ui-concept.jsx` — throwaway React mockup for UI/UX reference (`data-spec-ref` attributes cross-referenced in spec)

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

## Recommended setup order

Use the official `sv` CLI — do NOT manually scaffold.

```sh
npx sv create . --template minimal --types ts
npx sv add sveltekit-adapter   # picks Cloudflare (target: workers)
npx sv add tailwindcss
npx shadcn-svelte init          # interactive; set aliases to $lib paths
npx sv add drizzle             # Drizzle ORM integration
npx sv add eslint prettier
```

Wrangler config (`wrangler.jsonc`) needs:
- `compatibility_flags: ["nodejs_compat"]` (required for D1, crypto, etc.)
- D1 binding named `DB`
- Target Workers Static Assets (`main` + `assets.directory`), NOT Cloudflare Pages (being absorbed into Workers; Cron Triggers are Workers-only)

## Commands

| Task | Command |
|---|---|
| Dev server | `npm run dev` |
| Build | `npm run build` |
| Preview (CF Workers) | `wrangler dev` |
| Deploy | `wrangler deploy` |
| Lint | `npm run lint` |
| Typecheck | `npm run check` |
| Format | `npm run format` |
| Drizzle generate | `npx drizzle-kit generate` |
| Drizzle push (dev) | `npx drizzle-kit push` |

Run `lint → typecheck → build` before pushing.

## Architecture

- **Event-sourced sync**: Epic E (Offline & Sync) is sequenced before Epics F/G. All tracking writes go through the event pipeline from the start.
- Server code lives in `src/lib/server/` — never import from client.
- Client offline state lives in IndexedDB with a materialized-state layer.
- `hooks.server.ts` validates session cookies on every request.
- Auth flow: magic link → verify endpoint → httpOnly session cookie.

## Secrets

- `.dev.vars` for local Wrangler secrets (TMDB_API_KEY, RESEND_API_KEY, VAPID keys)
- `wrangler secret put <NAME>` for production
- Never commit `.dev.vars` — already in `.gitignore`

## Linear

- Epics A→H define the build order
- Issue IDs are `PAU-<n>` — reference in branch names: `paul/pau-<n>-short-slug`
