# Marquee

Track movies and TV shows you're watching, want to watch, and have completed — with offline support.

Progressive web app built with SvelteKit and deployed on Cloudflare. Tracks your viewing across devices with an event-sourced sync engine that works offline.

## Tech stack

| Layer         | Technology                                |
| ------------- | ----------------------------------------- |
| Framework     | SvelteKit (Svelte 5, runes)               |
| Deploy        | Cloudflare Workers (Static Assets)        |
| Database      | Cloudflare D1 (SQLite) via Drizzle ORM    |
| Styling       | Tailwind CSS v4 + shadcn-svelte + Bits UI |
| Auth          | Passwordless magic-link via Resend        |
| Media data    | TMDB API                                  |
| Offline       | IndexedDB + event-sourced sync            |
| Notifications | Web Push (VAPID)                          |

## Prerequisites

- [Node.js](https://nodejs.org/) 22 (matches CI)
- [pnpm](https://pnpm.io/) (`corepack enable pnpm`, or `npm i -g pnpm`)
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) — included as a dev dependency; run via `pnpm exec wrangler`
- [Docker](https://docs.docker.com/get-docker/) (for local email via Mailpit)
- [TMDB API key](https://developer.themoviedb.org/docs/getting-started)

## Getting started

```sh
# 1. Clone and install
git clone <repo-url> Marquee
cd Marquee
pnpm install

# 2. Create the local secrets file and fill in your keys
cp .dev.vars.example .dev.vars
# edit .dev.vars: TMDB_API_KEY, RESEND_API_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY

# 3. Create the D1 database and push the schema
pnpm exec wrangler d1 create marquee
pnpm db:push

# 4. (optional) Start Mailpit for local email
docker compose up -d

# 5. Start the dev server
pnpm dev
```

## Development

| Command          | Description                         |
| ---------------- | ----------------------------------- |
| `pnpm dev`       | Start dev server                    |
| `pnpm build`     | Production build                    |
| `pnpm preview`   | Run the built worker locally        |
| `pnpm lint`      | Lint code (Prettier check + ESLint) |
| `pnpm check`     | Typecheck                           |
| `pnpm format`    | Format code                         |
| `pnpm db:push`   | Push Drizzle schema to D1 (dev)     |
| `pnpm db:studio` | Open Drizzle Studio                 |

Run `lint → typecheck → build` before pushing.

## Project structure

```
src/
  lib/
    server/        # Server-only code — never import from client
      db/          # Drizzle schema + queries (D1)
    components/    # Shared Svelte components
  routes/          # SvelteKit file-based routing
```

## Deployment

Marquee deploys as a **Cloudflare Worker with static assets** (not Cloudflare Pages), configured in `wrangler.jsonc` (`nodejs_compat` flag, D1 binding `DB`).

```sh
pnpm build
pnpm exec wrangler deploy
```

If deploying via **Cloudflare Workers Builds** (git-connected), set the build environment variable `PNPM_VERSION` to match `packageManager` in `package.json` (currently `11.3.0`), and set the build command to `pnpm run build`. The default build image ships an older pnpm that ignores the `allowBuilds` setting in `pnpm-workspace.yaml`, which would skip native build scripts (`esbuild`, `workerd`) and break the build.

Set production secrets with:

```sh
pnpm exec wrangler secret put TMDB_API_KEY
pnpm exec wrangler secret put RESEND_API_KEY
pnpm exec wrangler secret put VAPID_PUBLIC_KEY
pnpm exec wrangler secret put VAPID_PRIVATE_KEY
```

## Learn more

- [Linear board (MRQ)](https://linear.app/paulbujor/team/MRQ)
- [SvelteKit docs](https://kit.svelte.dev/docs)
- [Cloudflare Workers docs](https://developers.cloudflare.com/workers/)
- [TMDB API docs](https://developer.themoviedb.org/docs)
