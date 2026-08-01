/**
 * Generate all app icons + iOS splash screens from the source logo set.
 *
 * Sources (all square, `dev-assets/`, 2048x2048 — larger is fine, everything
 * downscales). The mark comes in two colourways, light and dark, and in two
 * framings:
 *
 *   logo.png / logo-dark.png       plated mark, transparent squircle corners.
 *                                  The home-screen icon, and the splash mark.
 *   favicon.png / favicon-dark.png full-bleed mark, no plate. Stays legible at
 *                                  16px, where the plated art would shrink the
 *                                  mark to nothing.
 *   maskable.png                   opaque, padded to Android's safe zone.
 *                                  Light only — Android has no dark variant.
 *
 * Output: static/ (favicons, PWA icons, apple-touch icon, splash screens)
 *
 * Run: pnpm gen:icons  (or `node scripts/generate-icons.mjs`)
 *
 * To refresh everything, replace the source PNGs and re-run — no other edits.
 * Only two surfaces can switch colourway: the favicon (browsers honour
 * `media="(prefers-color-scheme: …)"` on the link) and the iOS splash (separate
 * `apple-touch-startup-image` links) — both wired up in `+layout.svelte`. The
 * home-screen and maskable icons have no per-scheme variant on either platform,
 * so they use the light colourway whatever the theme.
 */
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATIC = join(root, 'static');
const ICONS = join(STATIC, 'icons');
const SPLASH = join(STATIC, 'splash');

const SOURCES = {
	logo: 'logo.png',
	logoDark: 'logo-dark.png',
	maskable: 'maskable.png',
	favicon: 'favicon.png',
	faviconDark: 'favicon-dark.png'
};

// The app's two backgrounds, from `--background` in src/routes/layout.css.
// PLATE is separate on purpose: it's the logo artwork's own plate colour, a
// property of the art rather than of the app, and it backs the opaque
// apple-touch icon so iOS's corner rounding can't leave slivers around the
// squircle. Conflating the two is what left the old splashes seaming.
const BG = '#000000';
const LIGHT_BG = '#ffffff';
const PLATE = '#ffffff';

// Exact device resolutions (px) + home-screen icon size (pt). Portrait values;
// landscape swaps w/h. The splash renders the logo at the OS icon size (iconPt * dpr).
const DEVICES = [
	{ name: 'iphone15pro', w: 1179, h: 2556, dpr: 3, iconPt: 60 },
	// iPad Air (10.9"/11", 4th/5th/M2): 820x1180 pt @2 = 1640x2360 px.
	{ name: 'ipadair', w: 1640, h: 2360, dpr: 2, iconPt: 76 }
];

// Read every source up front so a missing or renamed file reports all of them
// by name, rather than an ENOENT stack trace for whichever one came first.
const src = {};
const missing = [];
for (const [key, file] of Object.entries(SOURCES)) {
	try {
		src[key] = await readFile(join(root, 'dev-assets', file));
	} catch {
		missing.push(file);
	}
}
if (missing.length) {
	console.error(`Missing source ${missing.length > 1 ? 'files' : 'file'} in dev-assets/:`);
	for (const file of missing) console.error(`  - ${file}`);
	process.exit(1);
}

const square = (input, size) => sharp(input).resize(size, size).png().toBuffer();

await rm(ICONS, { recursive: true, force: true });
await rm(SPLASH, { recursive: true, force: true });
await mkdir(ICONS, { recursive: true });
await mkdir(SPLASH, { recursive: true });

// 1. Browser favicons (PNG), light + dark, from the full-bleed sources
for (const [input, suffix] of [
	[src.favicon, ''],
	[src.faviconDark, '-dark']
]) {
	for (const s of [16, 32, 48]) {
		await sharp(input)
			.resize(s, s)
			.png()
			.toFile(join(ICONS, `favicon-${s}${suffix}.png`));
	}
}

// 2. Bundled .ico — light only; the format carries no colour-scheme variant, so
//    it stays the legacy `sizes="any"` fallback.
await writeFile(
	join(STATIC, 'favicon.ico'),
	await pngToIco([16, 32, 48].map((s) => join(ICONS, `favicon-${s}.png`)))
);

// 3. PWA "any" icons — the designed squircle as-is (transparent corners)
for (const s of [192, 512]) {
	await sharp(src.logo)
		.resize(s, s)
		.png()
		.toFile(join(ICONS, `icon-${s}.png`));
}

// 4. PWA maskable icons — from the dedicated full-bleed source, just resized
for (const s of [192, 512]) {
	await sharp(src.maskable)
		.resize(s, s)
		.png()
		.toFile(join(ICONS, `icon-${s}-maskable.png`));
}

// 5. Apple touch icon — 180, opaque (iOS blackens alpha), iOS rounds it
await sharp(src.logo)
	.resize(180, 180)
	.flatten({ background: PLATE })
	.png()
	.toFile(join(STATIC, 'apple-touch-icon.png'));

// 6. iOS splash screens — the matching colourway centred on the app bg, so the
//    plate dissolves into the background and the mark floats
for (const d of DEVICES) {
	for (const [orientation, W, H] of [
		['portrait', d.w, d.h],
		['landscape', d.h, d.w]
	]) {
		for (const [scheme, input, bg] of [
			['dark', src.logoDark, BG],
			['light', src.logo, LIGHT_BG]
		]) {
			const mark = await square(input, d.iconPt * d.dpr);
			await sharp({ create: { width: W, height: H, channels: 4, background: bg } })
				.composite([{ input: mark, gravity: 'center' }])
				.png()
				.toFile(join(SPLASH, `${d.name}-${orientation}-${scheme}.png`));
		}
	}
}

console.log('Icons + splash screens written to static/.');
