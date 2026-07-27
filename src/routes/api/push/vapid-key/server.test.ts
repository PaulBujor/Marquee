import { describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { GET } from './+server';

type GetEvent = Parameters<typeof GET>[0];

function call(user: { id: string } | null, publicKey?: string): ReturnType<typeof GET> {
	return GET({
		locals: { user },
		platform: publicKey === undefined ? { env: {} } : { env: { VAPID_PUBLIC_KEY: publicKey } }
	} as unknown as GetEvent);
}

async function status(run: () => unknown): Promise<number> {
	try {
		await run();
		throw new Error('expected throw');
	} catch (err) {
		if (isHttpError(err)) return err.status;
		throw err;
	}
}

describe('GET /api/push/vapid-key', () => {
	it('401s when unauthenticated', async () => {
		expect(await status(() => call(null, 'pub'))).toBe(401);
	});

	it('503s when the key is not configured', async () => {
		expect(await status(() => call({ id: 'u1' }, undefined))).toBe(503);
	});

	it('returns the public key for a signed-in user', async () => {
		const res = await call({ id: 'u1' }, 'pub-base64url');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ publicKey: 'pub-base64url' });
	});
});
