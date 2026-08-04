import { describe, expect, it } from 'vitest';
import {
	FULL_MEDIA_CHECK_MS,
	isFullMediaCheckDue,
	nextFullMediaCheckStamp,
	shouldRunMediaSync
} from './media-gate';

describe('isFullMediaCheckDue', () => {
	it('is not due before the interval has elapsed', () => {
		expect(isFullMediaCheckDue(1000, 1000 + FULL_MEDIA_CHECK_MS - 1)).toBe(false);
	});

	it('is due exactly at the interval boundary', () => {
		expect(isFullMediaCheckDue(1000, 1000 + FULL_MEDIA_CHECK_MS)).toBe(true);
	});

	it('is due well past the interval', () => {
		expect(isFullMediaCheckDue(1000, 1000 + FULL_MEDIA_CHECK_MS * 10)).toBe(true);
	});

	it('is due on the very first cycle (watermark 0, any now within the interval of epoch)', () => {
		expect(isFullMediaCheckDue(0, FULL_MEDIA_CHECK_MS)).toBe(true);
	});
});

describe('shouldRunMediaSync', () => {
	it('never short-circuits when the event channel pulled something, even if the full-check is not due', () => {
		expect(shouldRunMediaSync(1, 1000, 1000)).toBe(true);
		expect(shouldRunMediaSync(5, Date.now(), Date.now())).toBe(true);
	});

	it('runs when the full-check cadence is due, even with nothing pulled', () => {
		expect(shouldRunMediaSync(0, 1000, 1000 + FULL_MEDIA_CHECK_MS)).toBe(true);
	});

	it('skips when nothing was pulled and the full-check is not yet due', () => {
		expect(shouldRunMediaSync(0, 1000, 1000 + FULL_MEDIA_CHECK_MS - 1)).toBe(false);
	});

	it('runs when both conditions hold', () => {
		expect(shouldRunMediaSync(3, 1000, 1000 + FULL_MEDIA_CHECK_MS)).toBe(true);
	});
});

describe('nextFullMediaCheckStamp', () => {
	it('advances to now on a genuine success when a full check was due', () => {
		expect(nextFullMediaCheckStamp(true, true, 5000, 1000)).toBe(5000);
	});

	it('leaves the watermark untouched on success when no full check was due (light pass)', () => {
		expect(nextFullMediaCheckStamp(false, true, 5000, 1000)).toBe(1000);
	});

	it('leaves the watermark untouched on a breaker-open skip, even if a full check was due', () => {
		expect(nextFullMediaCheckStamp(true, false, 5000, 1000)).toBe(1000);
	});

	it('leaves the watermark untouched after a thrown error, even if a full check was due', () => {
		// A throw is represented the same way as a skip: succeeded=false.
		expect(nextFullMediaCheckStamp(true, false, 5000, 1000)).toBe(1000);
	});

	it('leaves the watermark untouched when neither due nor succeeded', () => {
		expect(nextFullMediaCheckStamp(false, false, 5000, 1000)).toBe(1000);
	});
});
