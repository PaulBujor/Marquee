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

/** The receiver's ceilings: an oversized batch, or one item naming too many episodes, is refused. */
const BATCH_MAX = 500;
const EPISODES_MAX = 500;

/** A paged read this long is not a library, it is a cursor that never ends. */
const PAGES_MAX = 100;

/** How much of a refusal's `detail` travels: enough to name the item, too little to be a payload. */
const DETAIL_MAX = 200;

/**
 * A failed call. `status` is the HTTP status, or **0** when there was no answer at all — a network
 * failure or the timeout, the one case a caller must retry without a status to read.
 *
 * The rest classify exactly as `queue.ts` treats the inbound path: 401 and 403 are a dead token or a
 * wrong host, which only pairing again recovers; 429 and 5xx are a wait; 400 is a request the
 * receiver refused, so replaying the same bytes changes nothing.
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
	let status = 0;

	for (let page = 0; page < PAGES_MAX; page += 1) {
		const url = new URL(`${client.marqueeUrl}/api/v1/library`);
		if (cursor) url.searchParams.set('cursor', cursor);

		const answer = await request(client, { url, method: 'GET' });
		status = answer.status;
		if (!isPage(answer.body)) throw new MarqueeError(status, 'Marquee answered without a page');

		entries.push(...answer.body.entries);
		if (!answer.body.nextCursor) return entries;
		// A receiver that echoes or ignores the cursor would otherwise be paged until the Worker dies.
		if (answer.body.nextCursor === cursor)
			throw new MarqueeError(status, 'Marquee repeated a cursor');

		cursor = answer.body.nextCursor;
	}

	throw new MarqueeError(status, `Marquee library is longer than ${PAGES_MAX} pages`);
}

/**
 * Applies every command, in as many requests as the receiver's ceilings need: one item per 500
 * episodes (as `queue.ts` splits the inbound intent) and one request per 500 items. A refusal is
 * the caller's to classify, but a batch it would refuse outright is never sent.
 */
export async function applyCommands(
	client: MarqueeClient,
	items: LibraryCommand[]
): Promise<LibraryBatchResult> {
	const total: LibraryBatchResult = { applied: 0, unchanged: 0, failed: [] };

	for (const batch of chunk(items.flatMap(byEpisodes), BATCH_MAX)) {
		const answer = await request(client, {
			url: new URL(`${client.marqueeUrl}/api/v1/library`),
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ items: batch })
		});
		if (!isBatchResult(answer.body))
			throw new MarqueeError(answer.status, 'Marquee answered without a batch result');

		total.applied += answer.body.applied;
		total.unchanged += answer.body.unchanged;
		total.failed.push(...answer.body.failed);
	}

	return total;
}

/** One item per 500 episodes: the receiver refuses a command that names more, and applies nothing. */
function byEpisodes(command: LibraryCommand): LibraryCommand[] {
	const episodes = command.episodes ?? [];
	if (episodes.length <= EPISODES_MAX) return [command];

	return chunk(episodes, EPISODES_MAX).map((part) => ({ ...command, episodes: part }));
}

function chunk<T>(list: T[], size: number): T[][] {
	const parts: T[][] = [];
	for (let index = 0; index < list.length; index += size)
		parts.push(list.slice(index, index + size));
	return parts;
}

/** A page of entries as the endpoint states it. Checked before use: a wire body is not a type. */
function isPage(body: unknown): body is { entries: LibraryEntry[]; nextCursor: string | null } {
	const page = body as { entries?: unknown; nextCursor?: unknown } | null;
	return (
		Array.isArray(page?.entries) &&
		(page?.nextCursor === null || typeof page?.nextCursor === 'string')
	);
}

function isBatchResult(body: unknown): body is LibraryBatchResult {
	const result = body as Partial<LibraryBatchResult> | null;
	return (
		typeof result?.applied === 'number' &&
		typeof result?.unchanged === 'number' &&
		Array.isArray(result?.failed)
	);
}

/** Header map rather than `RequestInit['headers']`, so spreading it cannot drop a `Headers` entry. */
type Call = { url: URL; method: string; headers?: Record<string, string>; body?: string };

/** The status travels with the body, so a shape the callers refuse carries the real one. */
type Answer = { status: number; body: unknown };

async function request(client: MarqueeClient, call: Call): Promise<Answer> {
	const fetchImpl = client.fetchImpl ?? fetch;

	let response: Response;
	try {
		response = await fetchImpl(call.url, {
			method: call.method,
			body: call.body,
			// A redirect would carry the bearer wherever it points.
			redirect: 'manual',
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			headers: { authorization: `Bearer ${client.token}`, ...call.headers }
		});
	} catch (error) {
		// No answer at all, so there is no status to carry: 0 is what a caller retries like a 5xx.
		throw new MarqueeError(
			0,
			`could not reach Marquee (${error instanceof Error ? error.name : 'unknown error'})`
		);
	}

	if (!response.ok) throw new MarqueeError(response.status, await refusal(response));

	const body = await response.json().catch(() => null);
	// A 200 that is not the envelope must not read as an empty library or a clean batch.
	if (body === null) throw new MarqueeError(response.status, 'Marquee did not answer with JSON');
	return { status: response.status, body };
}

/**
 * A refusal, plus the `detail` of the problem+json body the API adds to it — so a 400 from one bad
 * item names what was wrong with it. Best effort and capped: the URL and the headers stay out of it.
 */
async function refusal(response: Response): Promise<string> {
	const summary = `Marquee answered ${response.status}`;
	const detail = await response
		.json()
		.then((body: unknown) => (body as { detail?: unknown } | null)?.detail)
		.catch(() => null);

	return typeof detail === 'string' && detail !== ''
		? `${summary}: ${detail.slice(0, DETAIL_MAX)}`
		: summary;
}
