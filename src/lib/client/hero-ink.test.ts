import { describe, expect, it } from 'vitest';
import { boxLuminance, inkFor, inkForBoxes, relativeLuminance } from './hero-ink';

function pixels(
	width: number,
	height: number,
	colour: [number, number, number]
): Uint8ClampedArray {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		data[i * 4] = colour[0];
		data[i * 4 + 1] = colour[1];
		data[i * 4 + 2] = colour[2];
		data[i * 4 + 3] = 255;
	}
	return data;
}

describe('relativeLuminance', () => {
	it('is 0 for black and 1 for white', () => {
		expect(relativeLuminance(0, 0, 0)).toBe(0);
		expect(relativeLuminance(255, 255, 255)).toBeCloseTo(1, 5);
	});

	it('weights green above red above blue', () => {
		expect(relativeLuminance(0, 255, 0)).toBeGreaterThan(relativeLuminance(255, 0, 0));
		expect(relativeLuminance(255, 0, 0)).toBeGreaterThan(relativeLuminance(0, 0, 255));
	});
});

describe('inkFor', () => {
	it('picks white on a dark backdrop and black on a light one', () => {
		expect(inkFor(0)).toBe('light');
		expect(inkFor(0.05)).toBe('light');
		expect(inkFor(0.5)).toBe('dark');
		expect(inkFor(1)).toBe('dark');
	});

	it('switches where the two inks are equally readable, not at mid-grey', () => {
		// White on L and black on L cross at L = sqrt(0.0525) - 0.05 ≈ 0.179.
		expect(inkFor(0.17)).toBe('light');
		expect(inkFor(0.19)).toBe('dark');
	});
});

describe('boxLuminance', () => {
	it('averages only the pixels inside the box', () => {
		const data = pixels(4, 4, [255, 255, 255]);
		for (let y = 0; y < 2; y++) {
			for (let x = 0; x < 2; x++) {
				const i = (y * 4 + x) * 4;
				data[i] = data[i + 1] = data[i + 2] = 0;
			}
		}
		expect(boxLuminance(data, 4, { x: 0, y: 0, w: 2, h: 2 })).toBe(0);
		expect(boxLuminance(data, 4, { x: 2, y: 2, w: 2, h: 2 })).toBeCloseTo(1, 5);
	});
});

describe('inkForBoxes', () => {
	it('reads the top corners, where the controls sit', () => {
		const dark = pixels(40, 20, [10, 10, 10]);
		expect(inkForBoxes(dark, 40, 20).ink).toBe('light');
		const light = pixels(40, 20, [240, 240, 240]);
		expect(inkForBoxes(light, 40, 20).ink).toBe('dark');
	});

	it('ignores the middle of the image and the bottom band', () => {
		const data = pixels(40, 20, [10, 10, 10]);
		for (let y = 0; y < 20; y++) {
			for (let x = 10; x < 30; x++) {
				const i = (y * 40 + x) * 4;
				data[i] = data[i + 1] = data[i + 2] = 255;
			}
		}
		expect(inkForBoxes(data, 40, 20).ink).toBe('light');
	});

	it('reports the contrast of the worse corner, so a split backdrop can ask for a plate', () => {
		// One corner near-black, the other bright: white wins on the pair but only just clears 3:1.
		const split = pixels(40, 20, [0, 0, 0]);
		for (let y = 0; y < 6; y++) {
			for (let x = 30; x < 40; x++) {
				const i = (y * 40 + x) * 4;
				split[i] = split[i + 1] = split[i + 2] = 200;
			}
		}
		const { ink, contrast } = inkForBoxes(split, 40, 20);
		expect(ink).toBe('light');
		expect(contrast).toBeLessThan(3);
		expect(inkForBoxes(pixels(40, 20, [0, 0, 0]), 40, 20).contrast).toBeGreaterThan(20);
	});

	it('keeps the ink that stays readable on the worse of the two corners', () => {
		// Left corner near-black, right corner mid-grey: white still wins on both, black loses the left.
		const data = pixels(40, 20, [10, 10, 10]);
		for (let y = 0; y < 6; y++) {
			for (let x = 30; x < 40; x++) {
				const i = (y * 40 + x) * 4;
				data[i] = data[i + 1] = data[i + 2] = 120;
			}
		}
		expect(inkForBoxes(data, 40, 20).ink).toBe('light');
	});
});
