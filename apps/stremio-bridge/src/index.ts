/**
 * The Stremio bridge — the only place in this repo that knows Stremio exists.
 *
 * Two halves, one service:
 * - the **addon** (Stremio calls us): `/<handle>/manifest.json` and the `library`
 *   event route;
 * - the **account-API client** (we call Stremio's `api.strem.io`): the reconcile.
 *
 * Nothing here is imported by `apps/web`, and this package imports nothing from it.
 * The only contract between the two deployables is the HTTP API under
 * `apps/web/src/routes/api/v1` — see the "Stremio integration" project for the design.
 */
import { manifest, parseLibraryEvent } from './addon';
import { isHandle, newHandle, readBridge, writeBridge } from './bridges';
import { pair, renderForm, renderResult } from './configure';

/** The addon client is a browser page, so every response needs CORS — preflight included. */
const CORS: Record<string, string> = {
	'access-control-allow-origin': '*',
	'access-control-allow-headers': '*',
	'access-control-allow-methods': 'GET, POST, OPTIONS'
};

const notFound = () => new Response('Not found', { status: 404, headers: CORS });

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' }
	});

const redirect = (location: string) =>
	new Response(null, { status: 302, headers: { ...CORS, location } });

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
		if (url.pathname === '/healthz') return Response.json({ status: 'ok' });

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
		if (!(await readBridge(env.BRIDGES, handle))) return notFound();

		if (resource === 'manifest.json' && rest.length === 0) return json(manifest(handle));
		if (resource === 'library' && rest.length > 0) return library(rest);

		return notFound();
	}
} satisfies ExportedHandler<Env>;

async function configure(request: Request, env: Env, url: URL, handle: string): Promise<Response> {
	if (request.method === 'GET') return renderForm(handle);
	if (request.method !== 'POST')
		return new Response('Method not allowed', { status: 405, headers: CORS });

	const form = await request.formData().catch(() => null);
	const marqueeToken = String(form?.get('marqueeToken') ?? '').trim();
	const stremioAuthKey = String(form?.get('stremioAuthKey') ?? '').trim();

	if (!marqueeToken || !stremioAuthKey)
		return renderForm(handle, {
			field: 'marqueeToken',
			message: 'Both values are required.'
		});

	const result = await pair(env, { marqueeToken, stremioAuthKey });
	if (!result.ok) return renderForm(handle, { field: result.field, message: result.message });

	await writeBridge(env.BRIDGES, handle, result.record);
	return renderResult(url.host, handle);
}

/**
 * `/<handle>/library/{type}/{id}.json`, with the extra props as one more path segment. Stremio's
 * client is fire-and-forget: it ignores the reply and never retries, so an event we deliberately
 * drop is acknowledged exactly like one we act on.
 */
async function library(rest: string[]): Promise<Response> {
	const path = rest.join('/');
	if (!path.endsWith('.json')) return notFound();

	const [type, id, ...tail] = path.slice(0, -'.json'.length).split('/');
	if (!type || !id || tail.length > 1) return notFound();

	const parsed = parseLibraryEvent(type, id, tail[0]);
	if (parsed.kind === 'invalid') return notFound();

	if (parsed.kind === 'ignored') console.log(`[event] ignored ${parsed.reason}`);
	else console.log(`[event] ${JSON.stringify(parsed.event)}`);

	return json({ success: true });
}
