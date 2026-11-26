/**
 * The addon surface: what Stremio fetches from us, and how its library events are read.
 *
 * Every shape here comes from a real Stremio client, recorded by the spike against a live
 * account — the extra props arrive as a **path segment** with `&` literal and values
 * percent-encoded. The protocol also allows the query string, so the router accepts both.
 */

/** Marquee's vocabulary. Stremio's `series` becomes `show`; the translation stops here. */
export type MediaType = 'movie' | 'show';

export type AddonAction = 'libraryAdd' | 'libraryRemove' | 'watched' | 'unwatched';

const ACTIONS: ReadonlySet<string> = new Set([
	'libraryAdd',
	'libraryRemove',
	'watched',
	'unwatched'
] satisfies AddonAction[]);

/** An IMDb id. Stremio is IMDb-keyed, and the manifest only claims that prefix. */
const IMDB_ID = /^tt\d+$/;

/**
 * `resources: ['library']` and `idPrefixes: ['tt']` are what make Stremio route library events
 * here at all — an addon claiming neither is never asked. `catalogs: []` keeps us out of the
 * discovery surfaces: this addon syncs a library, it doesn't populate one.
 */
export function manifest(handle: string) {
	return {
		// The handle is part of the id so two pairings on one host don't collide in Stremio's
		// addon list, where the manifest id is what identifies an addon.
		id: `org.marquee.bridge.${handle}`,
		version: '1.0.0',
		name: 'Marquee',
		description: 'Two-way sync for your Marquee library: watched state and list membership.',
		resources: ['library'],
		types: ['movie', 'series'],
		idPrefixes: ['tt'],
		catalogs: [],
		behaviorHints: { adult: false }
	};
}

export interface LibraryEvent {
	/** Our vocabulary, already translated. */
	type: MediaType;
	/** Stremio's meta id — always `tt…`, because the manifest only claims that prefix. */
	id: string;
	action: AddonAction;
	/**
	 * Decoded `videoId`s, in one event however many were marked. Empty when the event carried
	 * none, which for a bare `watched` on a show means "mark nothing" — never "every episode".
	 */
	videoIds: string[];
}

export type LibraryParse =
	| { kind: 'event'; event: LibraryEvent }
	/** Well-formed, but about something we deliberately don't track. Acknowledged, never acted on. */
	| { kind: 'ignored'; reason: string }
	/** Not an event at all: a bad path, answered with a 404. */
	| { kind: 'invalid' };

/** Stremio's `series` is Marquee's `show`. Anything else is out of scope. */
function translateType(type: string): MediaType | null {
	if (type === 'movie') return 'movie';
	if (type === 'series') return 'show';
	return null;
}

export function parseLibraryEvent(
	type: string,
	id: string,
	extra: string | undefined
): LibraryParse {
	// `channel` (YouTube) and `tv` (live) are out of scope: their ids are not IMDb ids and
	// Marquee has no model for either.
	const mediaType = translateType(type);
	if (!mediaType) return { kind: 'ignored', reason: `type:${type}` };

	// `idPrefixes` is a routing hint Stremio honours, not a gate we control.
	if (!IMDB_ID.test(id)) return { kind: 'invalid' };

	const params = parseExtra(extra);
	if (!params) return { kind: 'invalid' };

	const action = last(params, 'action') ?? '';
	if (!ACTIONS.has(action)) return { kind: 'ignored', reason: `action:${action || 'none'}` };

	return {
		kind: 'event',
		event: {
			type: mediaType,
			id,
			action: action as AddonAction,
			videoIds: videoIdsFor(id, params)
		}
	};
}

/**
 * A videoId belongs to this event's title or it is not ours to act on: a foreign `tt…:s:e`
 * would otherwise be applied to whichever show the event named, putting an episode watch on the
 * wrong title. A movie's videoId is the title id itself; a series' is `id:season:episode`.
 */
function videoIdsFor(id: string, params: Map<string, string[]>): string[] {
	// Every `videoId` parameter counts: one event carries the whole season as a comma-separated
	// list, and a client that repeats the parameter instead would otherwise lose all but the last.
	return (params.get('videoId') ?? [])
		.flatMap((value) => value.split(','))
		.map((value) => value.trim())
		.filter((value) => value === id || value.startsWith(`${id}:`));
}

const last = (params: Map<string, string[]>, name: string): string | undefined =>
	params.get(name)?.at(-1);

/**
 * `extra` is `key=value` pairs joined by a literal `&`. A malformed percent-escape makes the
 * whole segment a bad path rather than a bad action, so a garbled request can't look like a
 * deliberate one.
 */
function parseExtra(extra: string | undefined): Map<string, string[]> | null {
	const params = new Map<string, string[]>();

	for (const pair of (extra ?? '').split('&')) {
		if (!pair) continue;
		const at = pair.indexOf('=');
		if (at < 0) continue;

		const name = pair.slice(0, at);
		try {
			// Decode before splitting: the observed wire form encodes the separators inside the
			// value (`%3A` for the colons, sometimes `%2C` for the commas).
			params.set(name, [...(params.get(name) ?? []), decodeURIComponent(pair.slice(at + 1))]);
		} catch {
			return null;
		}
	}

	return params;
}
