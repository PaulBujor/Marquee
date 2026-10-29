import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Unit tests run in the node environment; `#lib` resolves through package.json `imports`.
// The svelte plugin is needed even here (no DOM, no components rendered) because `.svelte.ts`
// rune modules — e.g. `LibraryState`/`TrackingState` — use `$state`/`$derived`, which only exist
// after the Svelte compiler transforms them; importing one without this plugin throws
// `$state is not defined`. `runes: true` matches the project-wide setting in vite.config.ts, which
// this standalone config doesn't read.
export default defineConfig({
	plugins: [svelte({ compilerOptions: { runes: true } })],
	resolve: {
		alias: {
			'cloudflare:workers': fileURLToPath(
				new URL('./src/lib/server/test/cloudflare-workers.ts', import.meta.url)
			)
		}
	},
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts'],
		coverage: {
			provider: 'v8',
			// The client half is as load-bearing as the server half — this app is offline-first, so
			// IndexedDB is the source of truth for the user's data — and it *is* tested. Scoping
			// coverage to `server/**` meant those tests ran but never appeared in the number CI
			// publishes, so a gap in the sync engine or the local projection was invisible to the one
			// signal meant to surface it. Excludes generated shadcn primitives and the type-only
			// wire-contract modules, which would otherwise dilute the figure without being testable.
			include: ['src/lib/**', 'src/routes/**/+server.ts'],
			exclude: ['src/lib/components/ui/**', 'src/lib/server/db/test-db.ts'],
			reporter: ['text', 'json-summary', 'html']
		}
	}
});
