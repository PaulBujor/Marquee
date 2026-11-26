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
export default {
	async fetch(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);

		// Readiness only. Every real route is per-user and keyed by a handle.
		if (pathname === '/healthz') return Response.json({ status: 'ok' });

		return new Response('Not found', { status: 404 });
	}
} satisfies ExportedHandler<Env>;
