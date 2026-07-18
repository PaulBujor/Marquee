// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { createDb } from '$lib/server/db';
import type { User } from '$lib/server/db/schema';

declare global {
	// App-consumed env vars/secrets, declared explicitly so they're typed even
	// where `wrangler types` can't see them (e.g. CI, which has no `.dev.vars`).
	// Merges with the wrangler-generated `Env` — keep these `string` to match it.
	interface Env {
		TMDB_API_KEY: string;
		RESEND_API_KEY: string;
		VAPID_PUBLIC_KEY: string;
		VAPID_PRIVATE_KEY: string;
		SMTP_HOST: string;
		SMTP_PORT: string;
		EMAIL_FROM: string;
	}

	namespace App {
		interface Platform {
			env: Env;
			ctx: ExecutionContext;
			caches: CacheStorage;
			cf?: IncomingRequestCfProperties;
		}

		// interface Error {}
		interface Locals {
			// Only set when platform bindings exist (dev proxy / deployed Worker); absent
			// during prerender/build. Server load functions must guard: `if (!locals.db) error(503)`.
			db?: ReturnType<typeof createDb>;
			// The authenticated user, or null. Set by the `authentication` hook on every
			// request from the session cookie.
			user: User | null;
		}
		// interface PageData {}
		// interface PageState {}
	}
}

export {};
