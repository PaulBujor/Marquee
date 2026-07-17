// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { createDb } from '$lib/server/db';

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
		}
		// interface PageData {}
		// interface PageState {}
	}
}

export {};
