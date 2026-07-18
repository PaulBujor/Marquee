import { describe, it, expect } from 'vitest';
import { generateToken, hashToken } from './tokens';

describe('generateToken', () => {
	it('is URL-safe base64 with 256 bits of entropy (43 chars, no padding)', () => {
		expect(generateToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it('is unique across many calls', () => {
		const tokens = new Set(Array.from({ length: 500 }, () => generateToken()));
		expect(tokens.size).toBe(500);
	});
});

describe('hashToken', () => {
	it('matches the known SHA-256 vector for "hello"', async () => {
		expect(await hashToken('hello')).toBe(
			'2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
		);
	});

	it('returns 64 lowercase hex characters', async () => {
		expect(await hashToken('anything')).toMatch(/^[0-9a-f]{64}$/);
	});

	it('is deterministic for the same input', async () => {
		expect(await hashToken('repeat-me')).toBe(await hashToken('repeat-me'));
	});

	it('differs for different inputs', async () => {
		expect(await hashToken('a')).not.toBe(await hashToken('b'));
	});
});
