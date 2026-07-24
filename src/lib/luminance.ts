/**
 * Average relative luminance (0..1) of the top-left corner of an image — used to choose a
 * contrasting colour for controls that float over artwork (e.g. the title-page back button).
 *
 * Load via a **same-origin** URL (our image proxy, {@link proxiedImageUrl}) so the canvas isn't
 * tainted by cross-origin pixels. Resolves `null` when the image can't be read (offline, load
 * error, or a tainted canvas) — callers fall back to a fixed frosted-glass treatment.
 */
export async function sampleCornerLuminance(
	url: string,
	{ sample = 24, region = 0.35 }: { sample?: number; region?: number } = {}
): Promise<number | null> {
	if (typeof document === 'undefined') return null;
	const img = new Image();
	img.crossOrigin = 'anonymous';
	img.decoding = 'async';
	try {
		await new Promise<void>((resolvePromise, reject) => {
			img.onload = () => resolvePromise();
			img.onerror = () => reject(new Error('image load failed'));
			img.src = url;
		});
		const w = img.naturalWidth;
		const h = img.naturalHeight;
		if (!w || !h) return null;

		const canvas = document.createElement('canvas');
		canvas.width = sample;
		canvas.height = sample;
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) return null;

		// Only sample the top-left region — that's where the floating control sits.
		const src = Math.max(1, Math.round(Math.min(w, h) * region));
		ctx.drawImage(img, 0, 0, src, src, 0, 0, sample, sample);
		const { data } = ctx.getImageData(0, 0, sample, sample);

		let sum = 0;
		let n = 0;
		for (let i = 0; i < data.length; i += 4) {
			// Rec. 709 relative luminance (cheap sRGB approximation, no gamma decode).
			sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
			n++;
		}
		return n ? sum / n : null;
	} catch {
		return null;
	}
}
