import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// SvelteKit/compiler config lives in svelte.config.js (the canonical location tooling reads).
export default defineConfig({
	plugins: [tailwindcss(), sveltekit()]
});
