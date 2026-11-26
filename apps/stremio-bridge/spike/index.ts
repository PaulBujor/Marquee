/**
 * Throwaway addon that records the exact requests Stremio sends, so the shapes the bridge is built
 * against come from a real client rather than from the protocol doc alone. Not part of any deploy
 * chain: `wrangler deploy -c spike/wrangler.jsonc` from apps/stremio-bridge.
 *
 * Events land in KV under `e:<ts>` instead of only in Workers Logs, because logs are only readable
 * from the dashboard and this has to be readable over HTTP to be useful.
 */

interface Env {
	SPIKE_KV: KVNamespace;
	SPIKE_KEY?: string;
}

const CORS: Record<string, string> = {
	'access-control-allow-origin': '*',
	'access-control-allow-headers': '*',
	'access-control-allow-methods': 'GET, POST, OPTIONS'
};

/** Declares `library` + `idPrefixes`, the two things that decide whether an event is routed here at all. */
const MANIFEST = {
	id: 'org.marquee.spike',
	version: '1.0.0',
	name: 'Marquee spike',
	description: 'Records library events. Temporary.',
	resources: ['library'],
	types: ['movie', 'series'],
	idPrefixes: ['tt'],
	catalogs: [],
	behaviorHints: { adult: false }
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { 'content-type': 'application/json', ...CORS }
	});
}

async function record(env: Env, request: Request, url: URL): Promise<void> {
	const entry = {
		at: new Date().toISOString(),
		method: request.method,
		pathname: url.pathname,
		search: url.search,
		/** The whole thing, because the `extra` encoding is one of the questions. */
		href: url.href,
		headers: Object.fromEntries(request.headers)
	};
	await env.SPIKE_KV.put(`e:${Date.now()}:${crypto.randomUUID()}`, JSON.stringify(entry), {
		expirationTtl: 60 * 60 * 24 * 7
	});
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

		if (url.pathname === '/events') {
			// The events are a user's watch activity, so they are not public just because the addon is.
			if (!env.SPIKE_KEY || url.searchParams.get('key') !== env.SPIKE_KEY) {
				return json({ ok: false, error: 'forbidden' }, 403);
			}
			const listed = await env.SPIKE_KV.list({ prefix: 'e:' });
			const events = await Promise.all(
				listed.keys.map(async (k) => JSON.parse((await env.SPIKE_KV.get(k.name)) ?? 'null'))
			);
			return json({ count: events.length, events });
		}

		await record(env, request, url);

		if (url.pathname === '/manifest.json') return json(MANIFEST);
		if (url.pathname.startsWith('/library/')) return json({ success: true });
		return json({ ok: true, note: 'recorded' });
	}
} satisfies ExportedHandler<Env>;
