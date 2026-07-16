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
			db: ReturnType<typeof createDb>;
		}
		// interface PageData {}
		// interface PageState {}
	}
}

export {};
