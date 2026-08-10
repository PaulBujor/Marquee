/**
 * Generate all app icons + iOS splash screens from the source logo set.
 *
 * Four sources (all square, `dev-assets/`, 2048x2048 — larger is fine,
 * everything downscales): one mark, in two framings x two colourways.
 *
 *   maskable.png / maskable-dark.png   Opaque, padded to Android's safe zone.
 *     Everything icon-shaped: the PWA icons, the apple-touch icon, and the
 *     splash mark. Declared `any maskable` in the manifest — one pair of files
 *     covers both purposes. Being opaque to the edges it renders as a square
 *     wherever `any` goes unmasked (Chrome desktop install, Windows taskbar);
 *     everywhere that masks it crops to the safe zone.
 *
 *   favicon.png / favicon-dark.png     Full-bleed mark, no plate. Stays legible
 *     at 16px, where the padded art would shrink the mark to nothing.
 *
 * `logo.png` / `logo-dark.png` — the plated mark with transparent squircle
 * corners — are kept in `dev-assets/` but deliberately NOT read: the squircle
 * fought every surface that applies its own rounding. Nothing consumes them;
 * wire them back up here if a surface wants the plated framing.
 *
 * Output: static/ (favicons, PWA icons, apple-touch icon, splash screens)
 *
 * Run: pnpm gen:icons  (or `node scripts/generate-icons.mjs`)
 *
 * To refresh everything, replace the source PNGs and re-run — no other edits.
 * Only two surfaces can switch colourway: the favicon (browsers honour
 * `media="(prefers-color-scheme: …)"` on the link) and the iOS splash (separate
 * `apple-touch-startup-image` links) — both wired up in `+layout.svelte`. The
 * home-screen icons have no per-scheme variant on either platform, so they use
 * the light colourway whatever the theme — a white plate reads on any wallpaper.
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
	maskable: 'maskable.png',
	maskableDark: 'maskable-dark.png',
	favicon: 'favicon.png',
	faviconDark: 'favicon-dark.png'
};

// The app's two backgrounds, from `--background` in src/routes/layout.css. They
// match the source plates, which is what makes each splash plate dissolve into
// its own background; the old #090a0e/#f7f6f3 pair is what left them seaming.
const BG = '#000000';
const LIGHT_BG = '#ffffff';
// The artwork's own plate colour — a property of the art, not of the app. Only
// reached if a source ever ships with alpha; the maskable pair is opaque.
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

// 1. Browser favicons (PNG), light + dark, from the full-bleed sources. 96 and 144 are for
//    the header mark's 2x/3x steps, not for any favicon slot.
for (const [input, suffix] of [
	[src.favicon, ''],
	[src.faviconDark, '-dark']
]) {
	for (const s of [16, 32, 48, 96, 144]) {
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

// 3. PWA icons — one pair serving both `any` and `maskable` (see manifest.json)
for (const s of [192, 512]) {
	await sharp(src.maskable)
		.resize(s, s)
		.png()
		.toFile(join(ICONS, `icon-${s}.png`));
}

// 4. Apple touch icon — 180, opaque (iOS blackens alpha), iOS rounds it
await sharp(src.maskable)
	.resize(180, 180)
	.flatten({ background: PLATE })
	.png()
	.toFile(join(STATIC, 'apple-touch-icon.png'));

// 5. iOS splash screens — the matching colourway centred on the app bg, so the
//    plate dissolves into the background and the mark floats
for (const d of DEVICES) {
	for (const [orientation, W, H] of [
		['portrait', d.w, d.h],
		['landscape', d.h, d.w]
	]) {
		for (const [scheme, input, bg] of [
			['dark', src.maskableDark, BG],
			['light', src.maskable, LIGHT_BG]
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
