import adapter from '@sveltejs/adapter-cloudflare';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: adapter(),
		// Content Security Policy. SvelteKit augments these directives with a nonce/hash
		// for the inline <script>/<style> it emits (mode 'auto': nonce when rendered, hash
		// when prerendered), so `script-src 'self'` still permits hydration.
		csp: {
			mode: 'auto',
			directives: {
				'default-src': ['self'],
				'script-src': ['self'],
				// Svelte/bits-ui transitions inject runtime inline <style>; per SvelteKit's CSP
				// docs these require 'unsafe-inline'. Google Fonts stylesheet is loaded in app.html.
				'style-src': ['self', 'unsafe-inline', 'https://fonts.googleapis.com'],
				'font-src': ['self', 'https://fonts.gstatic.com'],
				// data: for inline/blur placeholders; TMDB poster host for when the TMDB client lands.
				'img-src': ['self', 'data:', 'https://image.tmdb.org'],
				'connect-src': ['self'],
				'object-src': ['none'],
				'base-uri': ['self'],
				'frame-ancestors': ['none']
			}
		},
		typescript: {
			config: (config) => {
				config.include.push('../drizzle.config.ts');
			}
		}
	}
};

export default config;
