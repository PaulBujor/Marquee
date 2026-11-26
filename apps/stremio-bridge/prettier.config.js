/**
 * Same formatting as `apps/web`, minus its two plugins: there is no Svelte here, and the
 * Tailwind plugin would be pointed at a stylesheet this package does not have.
 *
 * @type {import("prettier").Config}
 */
const config = {
	useTabs: true,
	singleQuote: true,
	trailingComma: 'none',
	printWidth: 100
};

export default config;
