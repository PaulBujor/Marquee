import { describe, expect, it } from 'vitest';
import { isHandle, newHandle, readBridge, writeBridge, type BridgeRecord } from './bridges';
import { memoryKv } from './testing/kv';

const record: BridgeRecord = {
	marqueeToken: 'mqr_token',
	stremioAuthKey: 'stremio-key',
	createdAt: '2026-01-01T00:00:00.000Z'
};

describe('handle', () => {
	it('mints 256 bits of base64url behind its prefix', () => {
		const handle = newHandle();

		expect(handle).toMatch(/^sbr_[A-Za-z0-9_-]{43}$/);
		expect(handle).toHaveLength(47);
	});

	it('never repeats', () => {
		const handles = new Set(Array.from({ length: 1000 }, () => newHandle()));

		expect(handles.size).toBe(1000);
	});

	// The handle is the only credential on the addon surface, so the gate in front of KV has to
	// accept exactly what newHandle() can produce — no wider, or a guessable id reaches a lookup.
	it('accepts only what it could have minted', () => {
		const valid = newHandle();
		expect(isHandle(valid)).toBe(true);

		const rejected = [
			'',
			'sbr_',
			valid.slice(1),
			`${valid}x`,
			valid.slice(0, -1),
			`${valid.slice(0, -1)}!`,
			valid.replace('sbr_', 'SBR_')
		];

		for (const bad of rejected) expect(isHandle(bad)).toBe(false);
	});
});

describe('bridge records', () => {
	it('round-trips through KV and reports an unknown handle as absent', async () => {
		const kv = memoryKv();
		const handle = newHandle();

		expect(await readBridge(kv, handle)).toBeNull();

		await writeBridge(kv, handle, record);

		expect(await readBridge(kv, handle)).toEqual(record);
		expect(await readBridge(kv, newHandle())).toBeNull();
	});

	it('replaces the credentials when the same handle is paired again', async () => {
		const kv = memoryKv();
		const handle = newHandle();
		const rotated = { ...record, stremioAuthKey: 'rotated' };

		await writeBridge(kv, handle, record);
		await writeBridge(kv, handle, rotated);

		expect(await readBridge(kv, handle)).toEqual(rotated);
	});
});
