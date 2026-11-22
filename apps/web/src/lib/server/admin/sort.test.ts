import { describe, expect, it } from 'vitest';
import { parseSort } from './sort.js';

const allowed = ['createdAt', 'email', 'status'] as const;
const fallback = { key: 'createdAt', dir: 'desc' } as const;

describe('parseSort', () => {
	it('accepts a whitelisted column and direction', () => {
		expect(parseSort('email:asc', allowed, fallback)).toEqual({ key: 'email', dir: 'asc' });
		expect(parseSort('status:desc', allowed, fallback)).toEqual({ key: 'status', dir: 'desc' });
	});

	it('falls back for a column that is not in the map', () => {
		// The value would otherwise reach an ORDER BY, so unknown input must never survive.
		expect(parseSort('password_hash:asc', allowed, fallback)).toEqual(fallback);
		expect(parseSort('email; DROP TABLE users:asc', allowed, fallback)).toEqual(fallback);
		expect(parseSort(null, allowed, fallback)).toEqual(fallback);
	});

	it('keeps the chosen column but falls back for a junk direction', () => {
		expect(parseSort('email:sideways', allowed, fallback)).toEqual({ key: 'email', dir: 'desc' });
		expect(parseSort('email', allowed, fallback)).toEqual({ key: 'email', dir: 'desc' });
	});
});
