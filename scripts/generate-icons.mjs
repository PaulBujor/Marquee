/**
 * Generate all app icons + iOS splash screens from a single source logo.
 *
 * Sources (both 512x512):
 *   dev-assets/logo.png          — the icon, RGBA with transparent corners
 *   dev-assets/logo-maskable.png — full-bleed, padded to the safe zone (opaque)
 * Output: static/ (favicons, PWA icons, apple-touch icon, splash screens)
 *
 * Run: pnpm gen:icons  (or `node scripts/generate-icons.mjs`)
 *
 * To refresh everything, replace the source PNGs and re-run — no other edits.
 * Favicons + "any" PWA icons keep the logo's transparency. The maskable icons
 * are just resized from logo-maskable.png. `BG` (the app's dark `--background`,
 * #090a0e) fills the opaque apple-touch icon and matches the logo's own
 * background so nothing seams; splashes render both `BG` and the light bg.
 */
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'dev-assets/logo.png');
const SRC_MASKABLE = join(root, 'dev-assets/logo-maskable.png');
const STATIC = join(root, 'static');
const ICONS = join(STATIC, 'icons');
const SPLASH = join(STATIC, 'splash');

// App backgrounds, from --background: dark oklch(0.145 0.008 270) / light
// oklch(0.973 0.004 80). BG (dark) also fills the opaque apple-touch icon and
// matches the logo's own background, so nothing seams; splashes render both.
const BG = '#090a0e';
const LIGHT_BG = '#f7f6f3';

// Exact device resolutions (px) + home-screen icon size (pt). Portrait values;
// landscape swaps w/h. The splash renders the logo at the OS icon size (iconPt * dpr).
const DEVICES = [
	{ name: 'iphone15pro', w: 1179, h: 2556, dpr: 3, iconPt: 60 },
	{ name: 'ipadair', w: 1908, h: 2746, dpr: 2, iconPt: 76 }
];

const logo = await readFile(SRC);
const maskable = await readFile(SRC_MASKABLE);
const square = (size) => sharp(logo).resize(size, size).png().toBuffer();

await rm(ICONS, { recursive: true, force: true });
await rm(SPLASH, { recursive: true, force: true });
await mkdir(ICONS, { recursive: true });
await mkdir(SPLASH, { recursive: true });

// 1. Browser favicons (PNG) + bundled .ico
for (const s of [16, 32, 48]) {
	await sharp(logo)
		.resize(s, s)
		.png()
		.toFile(join(ICONS, `favicon-${s}.png`));
}
await writeFile(
	join(STATIC, 'favicon.ico'),
	await pngToIco([16, 32, 48].map((s) => join(ICONS, `favicon-${s}.png`)))
);

// 2. PWA "any" icons — the designed squircle as-is (transparent corners)
for (const s of [192, 512]) {
	await sharp(logo)
		.resize(s, s)
		.png()
		.toFile(join(ICONS, `icon-${s}.png`));
}

// 3. PWA maskable icons — from the dedicated full-bleed source, just resized
for (const s of [192, 512]) {
	await sharp(maskable)
		.resize(s, s)
		.png()
		.toFile(join(ICONS, `icon-${s}-maskable.png`));
}

// 4. Apple touch icon — 180, opaque (iOS blackens alpha), iOS rounds it
await sharp(logo)
	.resize(180, 180)
	.flatten({ background: BG })
	.png()
	.toFile(join(STATIC, 'apple-touch-icon.png'));

// 5. iOS splash screens — logo at OS icon size, centered on the app bg (light + dark)
for (const d of DEVICES) {
	const mark = await square(d.iconPt * d.dpr);
	for (const [orientation, W, H] of [
		['portrait', d.w, d.h],
		['landscape', d.h, d.w]
	]) {
		for (const [scheme, bg] of [
			['dark', BG],
			['light', LIGHT_BG]
		]) {
			await sharp({ create: { width: W, height: H, channels: 4, background: bg } })
				.composite([{ input: mark, gravity: 'center' }])
				.png()
				.toFile(join(SPLASH, `${d.name}-${orientation}-${scheme}.png`));
		}
	}
}

console.log('Icons + splash screens written to static/.');
