/**
 * Test-only wiring for the HTTP API: a real in-memory D1 with the committed migrations, real minted
 * tokens and real `Request`s, so a route test drives the same chain the Worker runs. Nothing here is
 * imported by app code.
 */
import { isHttpError } from '@sveltejs/kit';
import { createTestDb } from '#lib/server/db/test-db.js';
import { users } from '#lib/server/db/schema.js';
import { createApiToken } from '#lib/server/api/auth.js';
import type { ApiToken } from '#lib/server/db/schema.js';

export type TestDb = ReturnType<typeof createTestDb>;

const ORIGIN = 'https://marquee.test';
const TMDB_HOST = 'api.themoviedb.org';

export interface TestUser {
	id: string;
	email: string;
	/** Plaintext, minted once through `createApiToken`; only its hash is stored. */
	token: string;
	row: ApiToken;
}

export interface CallOptions {
	/** Path and query, e.g. `/api/v1/library?limit=1`. */
	path?: string;
	method?: string;
	/** Bearer token: the external API's only identity source. */
	token?: string | null;
	/** JSON body, serialized when present. */
	body?: unknown;
	/** Session identity. Null is the external API's case — no session, so the token must decide. */
	user?: { id: string } | null;
	/** Null simulates a request with no D1 binding. */
	db?: TestDb | null;
	params?: Record<string, string>;
}

/** The event a handler receives. An inline handler in a test annotates its param with this; a route handler needs no annotation. */
export interface TestEvent {
	request: Request;
	url: URL;
	locals: { db?: TestDb; user: { id: string } | null };
	params: Record<string, string>;
}

export interface TestApi {
	db: TestDb;
	alice: TestUser;
	bob: TestUser;
	/** Runs a route handler against a real Request and locals, and returns its Response. */
	call(handler: (event: never) => unknown, options?: CallOptions): Promise<Response>;
}

export async function createTestApi(): Promise<TestApi> {
	const db = createTestDb();
	return {
		db,
		alice: await seedUser(db, 'user-alice', 'alice@example.com'),
		bob: await seedUser(db, 'user-bob', 'bob@example.com'),
		call: (handler, options) => callHandler(db, handler, options)
	};
}

async function seedUser(db: TestDb, id: string, email: string): Promise<TestUser> {
	await db.insert(users).values({ id, email, status: 'enabled' });
	const { token, row } = await createApiToken(db, id, `${id} test token`);
	return { id, email, token, row };
}

async function callHandler(
	db: TestDb,
	handler: (event: never) => unknown,
	options: CallOptions = {}
): Promise<Response> {
	const {
		path = '/',
		method = 'GET',
		token = null,
		body,
		user = null,
		db: database = db,
		params = {}
	} = options;

	const url = new URL(path, ORIGIN);
	const headers = new Headers();
	if (token) headers.set('authorization', `Bearer ${token}`);
	if (body !== undefined) headers.set('content-type', 'application/json');

	const request = new Request(url, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const event: TestEvent = { request, url, locals: { db: database ?? undefined, user }, params };

	try {
		const response = await handler(event as never);
		if (!(response instanceof Response)) throw new Error(`No Response from ${method} ${path}`);
		return response;
	} catch (err) {
		// SvelteKit turns a thrown error() into a JSON response; a test should assert the status, not the throw.
		if (isHttpError(err)) return Response.json(err.body, { status: err.status });
		throw err;
	}
}

export interface TmdbStub {
	/** Registers a JSON reply for a TMDB path; the first registered match wins. */
	on(path: string | RegExp, body: unknown, init?: ResponseInit): TmdbStub;
	/** URLs requested through the stub, in order. */
	readonly requested: string[];
	/** Restores the previous global fetch. Call it in `afterEach`. */
	restore(): void;
}

/**
 * Replaces global fetch with a TMDB double that only answers registered paths — for the routes that
 * hydrate from TMDB. An unregistered URL throws: a test that silently passes against a URL nobody
 * stubbed is the failure mode this avoids.
 */
export function installTmdbFetch(): TmdbStub {
	const previous = globalThis.fetch;
	const routes: { path: string | RegExp; body: unknown; init?: ResponseInit }[] = [];
	const requested: string[] = [];

	const stub: TmdbStub = {
		on(path, body, init) {
			routes.push({ path, body, init });
			return stub;
		},
		requested,
		restore() {
			globalThis.fetch = previous;
		}
	};

	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		requested.push(url.toString());
		const route = routes.find((r) =>
			typeof r.path === 'string' ? url.pathname === r.path : r.path.test(url.pathname)
		);
		if (url.hostname !== TMDB_HOST || !route)
			throw new Error(`Unstubbed fetch: ${url} — register it with on(path, body)`);
		return Response.json(route.body, route.init);
	}) as typeof fetch;

	return stub;
}
