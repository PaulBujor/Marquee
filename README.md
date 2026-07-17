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
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm i -g wrangler`)
- [Docker](https://docs.docker.com/get-docker/) (for local email via Mailpit)
- [TMDB API key](https://developer.themoviedb.org/docs/getting-started)

## Getting started

```sh
# 1. Clone and install
git clone <repo-url> Marquee
cd Marquee
npm install

# 2. Create the local secrets file and fill in your keys
cp .dev.vars.example .dev.vars
# edit .dev.vars: TMDB_API_KEY, RESEND_API_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY

# 3. Create the D1 database and push the schema
wrangler d1 create marquee
npm run db:push

# 4. (optional) Start Mailpit for local email
docker compose up -d

# 5. Start the dev server
npm run dev
```

## Development

| Command             | Description                         |
| ------------------- | ----------------------------------- |
| `npm run dev`       | Start dev server                    |
| `npm run build`     | Production build                    |
| `npm run preview`   | Run the built worker locally        |
| `npm run lint`      | Lint code (Prettier check + ESLint) |
| `npm run check`     | Typecheck                           |
| `npm run format`    | Format code                         |
| `npm run db:push`   | Push Drizzle schema to D1 (dev)     |
| `npm run db:studio` | Open Drizzle Studio                 |

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
npm run build
wrangler deploy
```

Set production secrets with:

```sh
wrangler secret put TMDB_API_KEY
wrangler secret put RESEND_API_KEY
wrangler secret put VAPID_PUBLIC_KEY
wrangler secret put VAPID_PRIVATE_KEY
```

## Learn more

- [Linear board (MRQ)](https://linear.app/paulbujor/team/MRQ)
- [SvelteKit docs](https://kit.svelte.dev/docs)
- [Cloudflare Workers docs](https://developers.cloudflare.com/workers/)
- [TMDB API docs](https://developer.themoviedb.org/docs)
