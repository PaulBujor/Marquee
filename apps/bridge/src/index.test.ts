import { describe, expect, it } from 'vitest';
import worker from './index';

const get = (path: string) => worker.fetch(new Request(`https://bridge.test${path}`));

describe('bridge worker', () => {
	it('answers the readiness probe without touching a handle', async () => {
		const res = await get('/healthz');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: 'ok' });
	});

	// The handle is the only credential on the addon surface, so an unknown one must be
	// indistinguishable from any other unknown path — no echoing, no hint that it was close.
	it('404s an unknown handle without echoing it', async () => {
		const res = await get('/abc123/manifest.json');
		expect(res.status).toBe(404);
		expect(await res.text()).not.toContain('abc123');
	});

	it('404s a bare root', async () => {
		expect((await get('/')).status).toBe(404);
	});
});
