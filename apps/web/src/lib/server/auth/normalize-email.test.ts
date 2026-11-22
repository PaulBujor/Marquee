import { describe, it, expect } from 'vitest';
import { normalizeEmail } from './index';

describe('normalizeEmail', () => {
	it('trims surrounding whitespace', () => {
		expect(normalizeEmail('  a@b.com  ')).toBe('a@b.com');
	});

	it('lowercases the address', () => {
		expect(normalizeEmail('Foo@Bar.COM')).toBe('foo@bar.com');
	});

	it('trims and lowercases together', () => {
		expect(normalizeEmail('  MixedCase@Example.Com \n')).toBe('mixedcase@example.com');
	});
});
