import { describe, expect, it } from 'vitest';
import { codeField, emailField, firstError, normalizeEmail, signInModeField } from './index';

describe('normalizeEmail', () => {
	it('trims and lowercases', () => {
		expect(normalizeEmail('  Foo@Bar.COM \n')).toBe('foo@bar.com');
	});
});

describe('emailField', () => {
	it('accepts a plausible address (trimming first)', () => {
		expect(emailField.safeParse('  a@b.com  ').success).toBe(true);
		expect(emailField.parse('  a@b.com  ')).toBe('a@b.com');
	});

	it('rejects malformed addresses', () => {
		for (const bad of ['', 'no-at', 'a@b', 'a b@c.com', 'a@ b.com']) {
			expect(emailField.safeParse(bad).success).toBe(false);
		}
	});
});

describe('codeField', () => {
	it('accepts exactly six digits', () => {
		expect(codeField.safeParse('123456').success).toBe(true);
	});

	it('rejects anything else', () => {
		for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56']) {
			expect(codeField.safeParse(bad).success).toBe(false);
		}
	});
});

describe('signInModeField', () => {
	it('passes through known modes', () => {
		expect(signInModeField.parse('standalone')).toBe('standalone');
		expect(signInModeField.parse('browser')).toBe('browser');
	});

	it('falls back to browser for unknown/missing values', () => {
		expect(signInModeField.parse(null)).toBe('browser');
		expect(signInModeField.parse('nonsense')).toBe('browser');
	});
});

describe('firstError', () => {
	it('returns the message for a failing field', () => {
		const result = emailField.safeParse('nope');
		expect(result.success).toBe(false);
		if (!result.success) expect(firstError(result.error)).toBe('Enter a valid email address.');
	});
});
