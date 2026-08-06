import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Unit tests run in the node environment; the `$lib` alias mirrors SvelteKit's so imports resolve.
// The svelte plugin is needed even here (no DOM, no components rendered) because `.svelte.ts`
// rune modules — e.g. `LibraryState`/`TrackingState` — use `$state`/`$derived`, which only exist
// after the Svelte compiler transforms them; importing one without this plugin throws
// `$state is not defined`. `runes: true` matches the project-wide setting in svelte.config.js
// (which this standalone config doesn't read). Coverage focuses on the server logic under test.
export default defineConfig({
	plugins: [svelte({ compilerOptions: { runes: true } })],
	resolve: {
		alias: {
			$lib: fileURLToPath(new URL('./src/lib', import.meta.url))
		}
	},
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts'],
		coverage: {
			provider: 'v8',
			include: ['src/lib/server/**'],
			reporter: ['text', 'json-summary', 'html']
		}
	}
});
