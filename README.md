# Marquee

Track movies and TV shows you're watching, want to watch, and have completed — with offline support.

Progressive web app built with SvelteKit and deployed on Cloudflare. Tracks your viewing across devices with an event-sourced sync engine that works offline.

## Tech stack

| Layer | Technology |
|---|---|
| Framework | SvelteKit (Svelte 5, runes) |
| Deploy | Cloudflare Workers/Pages |
| Database | Cloudflare D1 (SQLite) via Drizzle ORM |
| Styling | Tailwind CSS v4 + shadcn-svelte + Bits UI |
| Auth | Passwordless magic-link via Resend |
| Media data | TMDB API |
| Offline | IndexedDB + event-sourced sync |
| Notifications | Web Push (VAPID) |

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm i -g wrangler`)
- [Docker](https://docs.docker.com/get-docker/) (for local email via Mailpit)
- [TMDB API key](https://developer.themoviedb.org/docs/getting-started)

## Getting started

```sh
# 1. Scaffold the project
npx sv create . --template minimal --types ts
npx sv add sveltekit-adapter
npx sv add tailwindcss
npx shadcn-svelte init
npx sv add drizzle
npx sv add eslint prettier
npm install

# 2. Create local secrets file
cat > .dev.vars << 'EOF'
TMDB_API_KEY=your_tmdb_api_key
RESEND_API_KEY=your_resend_api_key
VAPID_PUBLIC_KEY=your_vapid_public_key
VAPID_PRIVATE_KEY=your_vapid_private_key
EOF

# 3. Create D1 database and run migrations
wrangler d1 create marquee
npx drizzle-kit push

# 4. Start dev server
npm run dev
```

## Development

| Command | Description |
|---|---|
| `npm run dev` | Start dev server |
| `npm run build` | Production build |
| `npm run lint` | Lint code |
| `npm run check` | Typecheck |
| `npm run format` | Format code |

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

### Cloudflare Pages (recommended)

Connect your GitHub repo in the [Cloudflare dashboard](https://dash.cloudflare.com/). Set:
- Framework preset: SvelteKit
- Build command: `npm run build`
- Build output directory: `.svelte-kit/cloudflare`

Add the `nodejs_compat` compatibility flag in your project settings or `wrangler.jsonc`.

### Wrangler CLI

```sh
npm run build
wrangler pages deploy .svelte-kit/cloudflare
```

Set production secrets with:

```sh
wrangler secret put TMDB_API_KEY
wrangler secret put RESEND_API_KEY
wrangler secret put VAPID_PUBLIC_KEY
wrangler secret put VAPID_PRIVATE_KEY
```

## Learn more

- [Linear project](https://linear.app/paulbujor/project/marquee-fad148833ffe)
- [SvelteKit docs](https://kit.svelte.dev/docs)
- [Cloudflare Pages docs](https://developers.cloudflare.com/pages/)
- [TMDB API docs](https://developer.themovied.org/docs)
