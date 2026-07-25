import { describe, expect, it, vi } from 'vitest';
import { POST } from './+server';

/** Invoke the POST handler with a JSON body and a (possibly null) signed-in user. */
function call(body: unknown, user: { id: string } | null) {
	const request = new Request('http://localhost/api/client-error', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	// Only `request` + `locals.user` are read by the handler.
	return POST({ request, locals: { user } } as unknown as Parameters<typeof POST>[0]);
}

describe('POST /api/client-error', () => {
	it('logs a valid report for a signed-in user and returns 200', async () => {
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		const res = await call({ message: 'boom', source: 'sync', status: 500 }, { id: 'u1' });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true });
		expect(err).toHaveBeenCalledOnce();
		expect(String(err.mock.calls[0][0])).toContain('user=u1');
		err.mockRestore();
	});

	it('drops an unauthenticated report with 204 and does not log', async () => {
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		const res = await call({ message: 'boom' }, null);
		expect(res.status).toBe(204);
		expect(err).not.toHaveBeenCalled();
		err.mockRestore();
	});

	it('rejects a malformed body with 400', async () => {
		const res = await call({ notMessage: true }, { id: 'u1' });
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ ok: false });
	});
});
