// `logo*.png` in dev-assets/ is deliberately not read: its squircle fought every surface that applies its own rounding.
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

// Must match `--background` in src/routes/layout.css, or each splash plate seams against the page.
const BG = '#000000';
const LIGHT_BG = '#ffffff';
// The artwork's own plate colour, not the app's — only reached if a source ships with alpha.
const PLATE = '#ffffff';

// Resolutions in px, icon size in pt (splash renders the mark at iconPt * dpr); landscape swaps w/h.
const DEVICES = [
	{ name: 'iphone15pro', w: 1179, h: 2556, dpr: 3, iconPt: 60 },
	// iPad Air (10.9"/11", 4th/5th/M2): 820x1180 pt @2 = 1640x2360 px.
	{ name: 'ipadair', w: 1640, h: 2360, dpr: 2, iconPt: 76 }
];

// Read up front so a renamed source reports every miss by name, not one ENOENT at a time.
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

// 96 and 144 are the header mark's 2x/3x steps, not favicon slots.
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

// Light only: the .ico format carries no colour-scheme variant.
await writeFile(
	join(STATIC, 'favicon.ico'),
	await pngToIco([16, 32, 48].map((s) => join(ICONS, `favicon-${s}.png`)))
);

for (const s of [192, 512]) {
	await sharp(src.maskable)
		.resize(s, s)
		.png()
		.toFile(join(ICONS, `icon-${s}.png`));
}

// Opaque because iOS blackens alpha; iOS applies its own rounding to the 180px icon.
await sharp(src.maskable)
	.resize(180, 180)
	.flatten({ background: PLATE })
	.png()
	.toFile(join(STATIC, 'apple-touch-icon.png'));

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
