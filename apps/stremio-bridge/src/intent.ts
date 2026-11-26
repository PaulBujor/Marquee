/**
 * Stremio's actions, restated in Marquee's vocabulary.
 *
 * The bridge names an *intent* — "this is on the list", "these episodes are watched" — and never
 * an event. `apps/web`'s command translator decides which events that implies, and replaying the
 * same command is a no-op the second time, which is what makes at-least-once delivery safe.
 *
 * Two stated losses, both structural rather than accidental:
 * - `unwatched` on a movie becomes `want_to_watch`, so a title marked `did_not_finish` loses that
 *   flag. Stremio has no intent for "keep the status I have", and no wire shape can express it.
 * - an `unwatched` for a movie Marquee has never seen *adds* it to the watchlist as
 *   `want_to_watch`: the server cannot tell "un-watch" from "put on my list", since both are a
 *   status on a title with no row.
 * - Stremio's `id:season:episode` is **assumed** to be TMDB's numbering; nothing validates it
 *   against the catalogue. Where a show numbers differently (absolute numbering is the usual
 *   case) an episode watch lands on a coordinate that may be missing or may be another episode.
 *
 * shortcut: episode coordinates are not checked against the `episodes` table, validate them when
 * the reconcile starts reading the same catalogue and can tell a shifted season from a real one.
 */
import type { LibraryEvent } from './addon';

export type TrackingStatus = 'want_to_watch' | 'watching' | 'completed' | 'did_not_finish';

export interface EpisodeIntent {
	season: number;
	episode: number;
	watched: boolean;
}

/** The subset of the API's command body the bridge can produce. Mirrors `libraryCommandSchema`. */
export interface Intent {
	status?: TrackingStatus;
	removed?: boolean;
	episodes?: EpisodeIntent[];
}

/** Un-watching is not removal: the title stays on the list, just not finished. */
const UNWATCHED_STATUS: TrackingStatus = 'want_to_watch';

/**
 * The one translation table in the bridge. `null` means the event names nothing to change, which
 * is a deliberate answer rather than a failure — a bare `watched` on a show must mark **nothing**,
 * never "every aired episode".
 */
export function toIntent(event: LibraryEvent): Intent | null {
	if (event.action === 'libraryAdd') return { removed: false };
	if (event.action === 'libraryRemove') return { removed: true };

	if (event.type === 'show') {
		const episodes = episodesOf(event);
		return episodes.length > 0 ? { episodes } : null;
	}

	// A movie is a single title, so its watched state is the title's status; its videoId, when it
	// has one, is the title itself and names no episode.
	return { status: event.action === 'watched' ? 'completed' : UNWATCHED_STATUS };
}

function episodesOf(event: LibraryEvent): EpisodeIntent[] {
	const watched = event.action === 'watched';

	return event.videoIds
		.map((videoId) => coordinateOf(event.id, videoId))
		.filter((coordinate) => coordinate !== null)
		.map((coordinate) => ({ ...coordinate, watched }));
}

/** `tt123:2:5` → `{ season: 2, episode: 5 }`. Anything else names no episode we can act on. */
function coordinateOf(id: string, videoId: string): { season: number; episode: number } | null {
	// Checked rather than assumed: the ingress filters, but a queue body is typed, not validated,
	// and slicing a foreign id by `id.length` can land on a plausible pair (id `tt1`, videoId
	// `tt192:5` → `2:5`).
	if (!videoId.startsWith(`${id}:`)) return null;

	const [season, episode, ...extra] = videoId.slice(id.length + 1).split(':');
	if (extra.length > 0 || season === undefined || episode === undefined) return null;
	// Digits only: `Number('')` is 0 and `Number('0x2')` is 2, so coercion alone would accept
	// `tt1::2` as S0E2 and `tt1:0x2:3` as S2E3.
	if (!/^\d+$/.test(season) || !/^\d+$/.test(episode)) return null;

	const coordinate = { season: Number(season), episode: Number(episode) };
	// Season 0 is TMDB's Specials, so only the episode within a season is 1-based.
	if (!Number.isInteger(coordinate.season) || coordinate.season < 0) return null;
	if (!Number.isInteger(coordinate.episode) || coordinate.episode < 1) return null;

	return coordinate;
}
