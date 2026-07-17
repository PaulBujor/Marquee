// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { createDb } from '$lib/server/db';
import type { User } from '$lib/server/db/schema';

declare global {
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
