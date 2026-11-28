/**
 * A tick as the rewind dial passes a detent.
 *
 * Never load-bearing: `navigator.vibrate` is absent on iOS Safari and mostly ignored on desktop, so
 * every screen states the position in full without it. Only called on detent crossings (never from
 * a pointermove/rAF loop), and floored to one pulse per `MIN_GAP_MS` so a fast scrub can't stack.
 */
const STORAGE_KEY = 'marquee:rewind-haptics';
const PULSE_MS = 10;
const MIN_GAP_MS = 40;

function vibrate(): void {
	navigator.vibrate(PULSE_MS);
}

class Haptics {
	readonly supported = typeof navigator !== 'undefined' && 'vibrate' in navigator;
	enabled = $state(typeof window === 'undefined' || localStorage.getItem(STORAGE_KEY) !== 'off');
	#lastAt = 0;

	set(enabled: boolean): void {
		this.enabled = enabled;
		if (typeof window !== 'undefined') {
			localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
		}
	}

	tick(): void {
		if (!this.supported || !this.enabled) return;
		const now = Date.now();
		if (now - this.#lastAt < MIN_GAP_MS) return;
		this.#lastAt = now;
		vibrate();
	}
}

export const haptics = new Haptics();
