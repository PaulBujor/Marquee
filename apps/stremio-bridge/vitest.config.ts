import { defineConfig } from 'vitest/config';

// Plain node: the worker's handlers are ordinary functions over `Request`/`Response`,
// so the tests exercise them directly rather than through workerd. Anything that needs
// a real binding gets an explicit stub in the test, never a global.
export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts']
	}
});
