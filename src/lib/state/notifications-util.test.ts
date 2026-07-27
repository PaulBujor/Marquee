import { describe, expect, it } from 'vitest';
import { deviceLabel, urlBase64ToUint8Array } from './notifications-util';

describe('urlBase64ToUint8Array', () => {
	it('decodes base64url (with - and _) into the original bytes', () => {
		// bytes [251, 255, 190] encode as base64 "+/++" → base64url "-_--"
		expect(Array.from(urlBase64ToUint8Array('-_--'))).toEqual([251, 255, 190]);
	});

	it('handles missing padding', () => {
		// "TWFy" is padded ("Man"); "TWE" needs one '=' of padding → "Ma"
		expect(new TextDecoder().decode(urlBase64ToUint8Array('TWFu'))).toBe('Man');
		expect(new TextDecoder().decode(urlBase64ToUint8Array('TWE'))).toBe('Ma');
	});
});

describe('deviceLabel', () => {
	it('falls back when the UA is unknown', () => {
		expect(deviceLabel(undefined)).toBe('This device');
	});

	it('names the browser and OS', () => {
		expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537')).toBe(
			'Chrome on Windows'
		);
		expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Version/17 Safari/604')).toBe(
			'Safari on iOS'
		);
		expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0) Edg/120')).toBe('Edge on Windows');
	});
});
