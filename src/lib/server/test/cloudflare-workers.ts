// Vitest stand-in for Cloudflare's module: tests set bindings via `setTestBindings`, and `waitUntil`
// promises are drained rather than left to reject unnoticed.
type Bindings = Record<string, unknown>;

const state: { env: Bindings; pending: Promise<unknown>[] } = { env: {}, pending: [] };

export function setTestBindings(bindings: Bindings): void {
	state.env = bindings;
	state.pending = [];
}

export function testWaitUntil(): Promise<unknown>[] {
	return state.pending;
}

export const env = new Proxy({} as Bindings, {
	get: (_, prop) => state.env[prop as string],
	has: (_, prop) => prop in state.env
});

export function waitUntil(promise: Promise<unknown>): void {
	state.pending.push(promise);
}
