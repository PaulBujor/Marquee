/**
 * The Stremio bridge — the only place in this repo that knows Stremio exists.
 *
 * One service, two directions: Stremio calls the **addon** surface (`/<handle>/manifest.json`
 * and the `library` event route), and pairing calls **Stremio's account API** once to prove the
 * user's auth key. The reconcile that writes a user's Stremio state back into Marquee is not
 * here yet.
 *
 * Nothing here is imported by `apps/web`, and this package imports nothing from it. The only
 * contract between the two deployables is the HTTP API under `apps/web/src/routes/api/v1` — see
 * the "Stremio integration" project for the design.
 */
import { manifest, parseLibraryEvent } from './addon';
import { deleteBridge, isHandle, newHandle, readBridge, writeBridge } from './bridges';
import { pair, renderForm, renderResult } from './configure';
import { type InboundMessage, consume } from './queue';

/** The addon client is a browser page, so every response needs CORS — preflight included. */
const CORS: Record<string, string> = {
	'access-control-allow-origin': '*',
	'access-control-allow-headers': '*',
	'access-control-allow-methods': 'GET, POST, OPTIONS'
};

const notFound = () => new Response('Not found', { status: 404, headers: CORS });

const methodNotAllowed = (allow: string) =>
	new Response('Method not allowed', { status: 405, headers: { ...CORS, allow } });

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: {
			...CORS,
			'content-type': 'application/json; charset=utf-8',
			...headers
		}
	});

const redirect = (location: string) =>
	new Response(null, { status: 302, headers: { ...CORS, location } });

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
		if (url.pathname === '/healthz') return health(env);

		const segments = url.pathname.split('/').filter(Boolean);

		// Pairing starts by minting a handle into the URL. Nothing is stored until both
		// credentials check out, so a visit costs a KV write only when it succeeds.
		if (segments.length === 0 || (segments.length === 1 && segments[0] === 'configure')) {
			return redirect(`/configure/${newHandle()}`);
		}

		if (segments[0] === 'configure') {
			const [, handle, ...rest] = segments;
			if (!handle || !isHandle(handle) || rest.length > 0) return notFound();

			return configure(request, env, url, handle);
		}

		const [handle, resource, ...rest] = segments;
		if (!isHandle(handle)) return notFound();

		// Unpaired is indistinguishable from unknown: the handle is the only credential here, so
		// answering differently would confirm that a guessed handle exists.
		const bridge = await readBridge(env.BRIDGES, handle);
		if (!bridge) return notFound();

		// A pure function of the handle, so it can be cached — private, because the id embeds the
		// handle and the client refetches it constantly.
		if (resource === 'manifest.json' && rest.length === 0)
			return json(manifest(handle), 200, { 'cache-control': 'private, max-age=300' });

		if (resource === 'library' && rest.length > 0) return library(request, env, handle, url, rest);

		return notFound();
	},

	async queue(batch: MessageBatch<InboundMessage>, env: Env): Promise<void> {
		await consume(batch, env);
	}
} satisfies ExportedHandler<Env, InboundMessage>;

/** Exercises the binding, like `apps/web`'s probe exercises D1: a broken KV must not read healthy. */
async function health(env: Env): Promise<Response> {
	try {
		await env.BRIDGES.get('handle:healthz');
		return Response.json({ status: 'ok' });
	} catch {
		return Response.json({ status: 'unavailable' }, { status: 503 });
	}
}

async function configure(request: Request, env: Env, url: URL, handle: string): Promise<Response> {
	const existing = await readBridge(env.BRIDGES, handle);

	if (request.method === 'GET') return renderForm(handle, { paired: Boolean(existing) });
	if (request.method !== 'POST') return methodNotAllowed('GET, POST, OPTIONS');

	const form = await request.formData().catch(() => null);
	// Only a text field is a credential: `String(filePart)` would send "[object File]" upstream
	// and report the failure as a rejected token.
	const field = (name: string): string => {
		const value = form?.get(name);
		return typeof value === 'string' ? value.trim() : '';
	};

	const marqueeToken = field('marqueeToken');
	const stremioAuthKey = field('stremioAuthKey');
	const action = field('action');

	if (!marqueeToken)
		return renderForm(handle, {
			paired: Boolean(existing),
			error: { field: 'marqueeToken', message: 'The Marquee token is required.' }
		});

	// A handle is a capability to *use* a bridge, not to take it over: repointing one requires
	// the token it is already paired with. Changing account means starting a new bridge.
	if (existing && marqueeToken !== existing.marqueeToken)
		return renderForm(handle, {
			paired: true,
			status: 409,
			error: {
				field: 'marqueeToken',
				message: 'This bridge is already paired. Create a new one to pair it again.'
			}
		});

	if (action === 'unpair') {
		await deleteBridge(env.BRIDGES, handle);
		return renderResult(url.host, handle, { unpaired: true });
	}

	if (!stremioAuthKey)
		return renderForm(handle, {
			paired: Boolean(existing),
			error: { field: 'stremioAuthKey', message: 'The Stremio auth key is required.' }
		});

	const result = await pair(
		{
			// A paired bridge stays bound to the Marquee its token was minted for.
			marqueeApi: existing?.marqueeUrl ?? env.MARQUEE_API_URL,
			stremioApi: env.STREMIO_API_URL
		},
		{ marqueeToken, stremioAuthKey }
	);

	if (!result.ok)
		return renderForm(handle, {
			paired: Boolean(existing),
			error: { field: result.field, message: result.message }
		});

	await writeBridge(env.BRIDGES, handle, result.record);
	return renderResult(url.host, handle);
}

/**
 * `/<handle>/library/{type}/{id}.json`, with the extra props as one more path segment — or, as
 * the protocol also allows, in the query string. Stremio's client is fire-and-forget: it ignores
 * the reply and never retries, so an event we deliberately drop is acknowledged exactly like one
 * we act on, and anything we cannot parse is a 404 rather than a silent success.
 */
async function library(
	request: Request,
	env: Env,
	handle: string,
	url: URL,
	rest: string[]
): Promise<Response> {
	// A crawler's HEAD or a stray DELETE must not become a user action once the write path lands.
	if (request.method !== 'GET') return methodNotAllowed('GET, OPTIONS');

	const path = rest.join('/');
	if (!path.endsWith('.json')) return notFound();

	const [type, id, ...tail] = path.slice(0, -'.json'.length).split('/');
	if (!type || !id || tail.length > 1) return notFound();

	const parsed = parseLibraryEvent(type, id, tail[0] ?? url.search.slice(1));
	if (parsed.kind === 'invalid') return notFound();

	// The handle is in the line on purpose: a dropped event is unrecoverable, so the log is the
	// only place anyone could notice it, and it has to be attributable.
	if (parsed.kind === 'ignored') {
		console.warn(`[event] ${handle} ignored ${parsed.reason}`);
	} else {
		console.log(`[event] ${handle} ${JSON.stringify(parsed.event)}`);

		// Queue, then reply: Stremio is waiting, and Marquee (and TMDB behind it) is not fast.
		const message: InboundMessage = {
			...parsed.event,
			handle,
			receivedAt: new Date().toISOString()
		};
		try {
			await env.INBOUND.send(message);
		} catch (error) {
			// Nothing to fall back to: the client ignores the reply and never retries.
			console.error(`[event] ${handle} could not be queued`, error);
		}
	}

	return json({ success: true }, 200, { 'cache-control': 'no-store' });
}
