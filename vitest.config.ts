import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Unit tests run in the node environment; the `$lib` alias mirrors SvelteKit's
// so imports resolve. Coverage focuses on the server logic under test.
export default defineConfig({
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
