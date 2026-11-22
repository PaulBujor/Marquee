export type Ink = 'light' | 'dark';

export interface HeroInk {
	ink: Ink;
	/** Contrast ratio of that ink against the worse of the two sampled corners. */
	contrast: number;
}

const SAMPLE_WIDTH = 64;
const BAND_HEIGHT = 0.3;
const BOX_WIDTH = 0.25;

function channel(value: number): number {
	const s = value / 255;
	return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(r: number, g: number, b: number): number {
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(ink: Ink, luminance: number): number {
	const [hi, lo] = ink === 'light' ? [1, luminance] : [luminance, 0];
	return (hi + 0.05) / (lo + 0.05);
}

export function inkFor(luminance: number): Ink {
	return contrast('light', luminance) >= contrast('dark', luminance) ? 'light' : 'dark';
}

export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

export function boxLuminance(pixels: Uint8ClampedArray, width: number, box: Box): number {
	let total = 0;
	let count = 0;
	for (let y = box.y; y < box.y + box.h; y++) {
		for (let x = box.x; x < box.x + box.w; x++) {
			const i = (y * width + x) * 4;
			total += relativeLuminance(pixels[i], pixels[i + 1], pixels[i + 2]);
			count++;
		}
	}
	return count === 0 ? 0 : total / count;
}

export function inkForBoxes(pixels: Uint8ClampedArray, width: number, height: number): HeroInk {
	const band = Math.max(1, Math.round(height * BAND_HEIGHT));
	const boxWidth = Math.max(1, Math.round(width * BOX_WIDTH));
	const boxes: Box[] = [
		{ x: 0, y: 0, w: boxWidth, h: band },
		{ x: width - boxWidth, y: 0, w: boxWidth, h: band }
	];
	const luminances = boxes.map((box) => boxLuminance(pixels, width, box));
	const worst = (ink: Ink) => Math.min(...luminances.map((l) => contrast(ink, l)));
	const ink: Ink = worst('light') >= worst('dark') ? 'light' : 'dark';
	return { ink, contrast: worst(ink) };
}

export async function heroInk(url: string): Promise<HeroInk | null> {
	if (typeof document === 'undefined') return null;
	const image = new Image();
	image.crossOrigin = 'anonymous';
	image.src = url;
	try {
		await image.decode();
	} catch {
		return null;
	}
	const width = SAMPLE_WIDTH;
	const height = Math.max(1, Math.round((width * image.naturalHeight) / image.naturalWidth));
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext('2d', { willReadFrequently: true });
	if (!context) return null;
	context.drawImage(image, 0, 0, width, height);
	try {
		return inkForBoxes(context.getImageData(0, 0, width, height).data, width, height);
	} catch {
		return null;
	}
}
