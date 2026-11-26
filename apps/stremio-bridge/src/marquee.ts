/**
 * The receiver client: read a library, apply a batch of commands.
 *
 * This module knows Marquee's HTTP shapes and nothing else, so the merge that plans a batch stays
 * testable without a network and a request shape can change without touching the merge. There is no
 * retry here either: the caller owns the schedule, and a client that retried inside a reconcile
 * would hold its per-handle lock for as long as the outage lasted.
 */
import type { MediaType } from './addon';
import type { Intent, TrackingStatus } from './intent';

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * A non-success answer. The status is what a caller branches on: 401 means the stored token is dead
 * and only pairing again recovers, while 429 and 5xx are a wait.
 */
export class MarqueeError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = 'MarqueeError';
		this.status = status;
	}
}

export interface MarqueeClient {
	/** The host the token was minted for — never the Worker's own env, which a re-pair can change. */
	marqueeUrl: string;
	token: string;
	/** Injected so tests never reach the network; defaults to the global `fetch`. */
	fetchImpl?: typeof fetch;
}

/**
 * One command in a batch: which title, and what about it changes. `Intent` already carries the
 * vocabulary, so the wire shape is that plus an address.
 */
export type LibraryCommand = { type: MediaType; id: string } & Intent;

export type LibraryBatchFailureCode = 'unresolved' | 'not_found' | 'upstream_unavailable';

/** What a batch did, per title: `failed` names the ones that did not apply and why. */
export interface LibraryBatchResult {
	applied: number;
	unchanged: number;
	failed: { id: string; code: LibraryBatchFailureCode; reason: string }[];
}

/**
 * One entry of `GET /api/v1/library`, narrowed to what a caller needs to project it into Stremio's
 * vocabulary. The full shape — every timestamp, the title, the cursor — is apps/web's.
 */
export interface LibraryEntry {
	tracking: { mediaId: string; status: TrackingStatus; removed: boolean };
	media: { id: string; type: MediaType };
	/** Null for movies. `watched: false` rows are kept: an un-watch is a state, not an absence. */
	episodes: { season: number; episode: number; watched: boolean }[] | null;
}

/**
 * Every entry the user has, walking the endpoint's cursor to the end. Records are re-read in full
 * rather than fetched by change, because a reconcile compares state, not events.
 */
export async function listLibrary(client: MarqueeClient): Promise<LibraryEntry[]> {
	const entries: LibraryEntry[] = [];
	let cursor: string | null = null;

	for (;;) {
		const url = new URL(`${client.marqueeUrl}/api/v1/library`);
		if (cursor) url.searchParams.set('cursor', cursor);

		const page = await request<{ entries: LibraryEntry[]; nextCursor: string | null }>(client, {
			url,
			method: 'GET'
		});
		entries.push(...page.entries);
		if (!page.nextCursor) return entries;
		cursor = page.nextCursor;
	}
}

/**
 * Applies one batch. The receiver takes at most 500 items per request, so a longer list is the
 * caller's to chunk — and a title it refuses is reported in `failed` while its siblings still apply.
 */
export async function applyCommands(
	client: MarqueeClient,
	items: LibraryCommand[]
): Promise<LibraryBatchResult> {
	return await request<LibraryBatchResult>(client, {
		url: new URL(`${client.marqueeUrl}/api/v1/library`),
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ items })
	});
}

/** Header map rather than `RequestInit['headers']`, so spreading it cannot drop a `Headers` entry. */
type Call = { url: URL; method: string; headers?: Record<string, string>; body?: string };

async function request<T>(client: MarqueeClient, call: Call): Promise<T> {
	const fetchImpl = client.fetchImpl ?? fetch;
	const response = await fetchImpl(call.url, {
		method: call.method,
		body: call.body,
		// A redirect would carry the bearer wherever it points.
		redirect: 'manual',
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		headers: { authorization: `Bearer ${client.token}`, ...call.headers }
	});

	if (!response.ok) throw new MarqueeError(response.status, `Marquee answered ${response.status}`);

	// A 200 that is not the envelope must not read as an empty library or a clean batch.
	const body = (await response.json().catch(() => null)) as T | null;
	if (body === null) throw new MarqueeError(response.status, 'Marquee did not answer with JSON');
	return body;
}
