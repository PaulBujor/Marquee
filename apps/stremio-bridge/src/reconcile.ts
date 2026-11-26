/**
 * The merge: per title, what Stremio says now, what Marquee says now, and what both sides last
 * agreed on — turned into a plan of writes for each direction.
 *
 * Pure by construction: it reads no binding, calls nothing, and knows Marquee's state only as
 * `MarqueeTitle`, restated in Stremio's vocabulary. The one wire it does know is Stremio's, because
 * a `datastorePut` **replaces** the record it writes: a plan carrying only the changed fields would
 * delete every field it left out, so a put is always the item as it was read.
 */
import watchedBitfield from 'stremio-watched-bitfield';
import { isImdbId, type MediaType } from './addon';
import type { LibraryCommand } from './marquee';

/**
 * Marquee's state for one title, in Stremio's vocabulary — a projection, never the API's wire shape.
 *
 * The adapter that produces these is deliberately absent: it needs an IMDb id per library entry,
 * which the library read does not carry yet. Until it does, nothing can fill `id`. A title with no
 * IMDb alias is unrepresentable in Stremio, so that adapter must skip and log it — inventing an id
 * would address a different title, and no id at all is not an address.
 */
export interface MarqueeTitle {
	/** The IMDb id both sides know the title by; anything else cannot be addressed in Stremio. */
	id: string;
	type: MediaType;
	/** Marquee's tombstone: the title is off the list, but its row and history remain. */
	removed: boolean;
	/**
	 * Watched videos in Stremio's key vocabulary — the title id itself for a movie, `${id}:${season}:${episode}`
	 * for an episode — never Marquee's own season/episode pairs. Composing those keys is the
	 * adapter's job: it has the numbers, while a bitfield has only positions.
	 */
	watched: string[];
}

/** What both sides last agreed on for one title, in the same vocabulary. */
export interface SnapshotItem {
	removed: boolean;
	watched: string[];
}

/** Per title, by IMDb id. An id with no entry has never been agreed on. */
export type Snapshot = Record<string, SnapshotItem>;

/**
 * The fields of a Stremio library item this module reads. A put is the whole item, so the fields it
 * does not name ride along untouched.
 */
export interface StremioItem {
	_id: string;
	type: 'movie' | 'series' | 'channel' | 'tv';
	temp: boolean;
	removed: boolean;
	/** Read, never rebuilt. Absent on a body that is not the shape this type hopes for. */
	state?: { watched?: string };
}

export interface ReconcileInput {
	/** Marquee's side, already projected. */
	entries: MarqueeTitle[];
	/** Stremio's whole library, as `datastoreGet` returns it. */
	items: StremioItem[];
	snapshot: Snapshot;
	/** Catalogue ordering per series id (`tt…` → `['tt…:1:1', …]`): the bitfield is positional. */
	videoKeys: Record<string, string[]>;
}

export type ConflictReason =
	/** A projection entry that is not addressable in Stremio, or that contradicts the item. */
	| 'invalid-entry'
	| 'type-mismatch'
	/** A series whose catalogue ordering is unknown: its watched set cannot be read or written. */
	| 'no-video-keys'
	/** A serialized bitfield that cannot be read against the ordering we have. */
	| 'unreadable-watched'
	/** Marquee knows a title Stremio has never had; a put would have to invent the item. */
	| 'not-in-stremio'
	/** Stremio moved away from the snapshot; that change belongs to the inbound queue. */
	| 'stremio-changed';

/** Something the merge deliberately did not decide, reported rather than guessed at. */
export interface Conflict {
	id: string;
	reason: ConflictReason;
}

export interface ReconcilePlan {
	/** Full items for `datastorePut`, changed ones only. */
	puts: StremioItem[];
	commands: LibraryCommand[];
	/**
	 * The agreement to record. Persist it only once every put and command above has been applied —
	 * the plan is idempotent, so an unapplied plan is re-planned rather than lost.
	 */
	snapshot: Snapshot;
	conflicts: Conflict[];
}

/** Stremio's `series` is Marquee's `show`; `channel` and `tv` are out of scope for the merge. */
const mediaType = (type: StremioItem['type']): MediaType | null => {
	if (type === 'movie') return 'movie';
	if (type === 'series') return 'show';
	return null;
};

/**
 * A write per side, decided by whose change the difference is. Nothing is written when the two sides
 * agree, and nothing is written to Stremio when Stremio is somewhere the snapshot does not recognise.
 */
export function planReconcile(input: ReconcileInput): ReconcilePlan {
	const titles = new Map(input.entries.map((entry) => [entry.id, entry]));
	const items = new Map(input.items.map((item) => [item._id, item]));
	const plan: ReconcilePlan = {
		puts: [],
		commands: [],
		snapshot: { ...input.snapshot },
		conflicts: []
	};

	for (const id of new Set([...items.keys(), ...titles.keys(), ...Object.keys(input.snapshot)])) {
		const item = items.get(id) ?? null;
		const title = titles.get(id) ?? null;
		const agreed = input.snapshot[id] ?? null;
		const conflict = (reason: ConflictReason): void => {
			plan.conflicts.push({ id, reason });
		};

		// Gone from both sides: the snapshot is history nobody can act on any more.
		if (!item && !title) {
			delete plan.snapshot[id];
			continue;
		}

		// A channel or live-TV item is never imported and never mistaken for a deletion.
		if (item && !mediaType(item.type)) continue;
		// The projection is caller-supplied, so an id Stremio could not address is refused, not dropped.
		if (title && !isImdbId(title.id)) {
			conflict('invalid-entry');
			continue;
		}

		if (!item) {
			// Stremio never had this title, so there is nothing to echo: the put would have to invent
			// the item (its name, poster and own state fields), which the merge never does.
			conflict(agreed ? 'stremio-changed' : 'not-in-stremio');
			continue;
		}

		const type = mediaType(item.type) as MediaType;
		if (title && title.type !== type) {
			conflict('type-mismatch');
			continue;
		}

		// A movie's bitfield is indexed by its own id — one bit, so no ordering to look up.
		const keys = type === 'movie' ? [item._id] : input.videoKeys[item._id];
		// Never a guess: without the ordering the bitfield was written against, a decode would answer
		// with the wrong set, and writing that back would drop watched bits Stremio holds.
		if (!keys || keys.length === 0) {
			conflict('no-video-keys');
			continue;
		}

		const watched = readWatched(item.state?.watched, keys);
		if (!watched) {
			conflict('unreadable-watched');
			continue;
		}

		// Stremio's four shapes in Marquee's two: `temp` is "played but never added", which Marquee
		// can only hold as tracked — there is no watched-but-unlisted there.
		const stremio: SnapshotItem = { removed: !item.temp && item.removed, watched };
		const marquee: SnapshotItem | null = title && {
			removed: title.removed,
			watched: title.watched
		};

		// Agreement is not just the same values: a `temp` item is not in the user's library, so a title
		// Marquee tracks has to be promoted into one — otherwise it stays outside that library for ever.
		if (marquee && !item.temp && agrees(stremio, marquee)) {
			plan.snapshot[id] = stremio;
			continue;
		}

		if (agreed && !agrees(stremio, agreed)) {
			// Stremio is not where we left it. That change reached Marquee through the inbound queue as
			// the user's intent; writing over it here would replace a newer state with an older one.
			//
			// shortcut: the conflict never resolves on its own — this branch leaves the snapshot where it
			// is, so the same divergence is reported every run until the inbound path catches up with
			// Stremio, and if that path lost the event nothing ever will. A resolution rule needs the
			// applied marker the Durable Object will own, so it is not invented here.
			conflict('stremio-changed');
			continue;
		}

		if (agreed && marquee) {
			// Stremio is exactly where we left it, so the difference is Marquee's to push. The union
			// decides the watched set: a bit either side knows is a watch that happened.
			const union = new Set([...watched, ...marquee.watched]);
			const merged = keys.filter((key) => union.has(key));
			const target: SnapshotItem = { removed: marquee.removed, watched: merged };

			plan.snapshot[id] = target;
			// What matters is what the stored field means, not the string it is stored as: Stremio writes
			// one per episode count, so a shorter universe holding the same set re-encodes to a longer
			// string, and that is not a change. A `temp` item is always written, to promote it.
			// A difference no field can express — an un-watched bit — is a loss by design, not a write.
			if (!item.temp && agrees(stremio, target)) continue;

			plan.puts.push({
				...item,
				removed: target.removed,
				temp: false,
				state: { ...item.state, watched: encode(keys, merged) }
			});
			continue;
		}

		// Nothing agreed yet, or Marquee has no row: Stremio is the only state there is, so Marquee is
		// told to match it. A removal is never pushed that way — it would take the episode progress
		// with it, and every real removal already arrived through the inbound queue.
		if (!stremio.removed) plan.commands.push(listing(item, type, watched));
		plan.snapshot[id] = stremio;
	}

	return plan;
}

/** One title, listed, with the watched state Stremio holds for it. Never a `watched: false`. */
function listing(item: StremioItem, type: MediaType, watched: string[]): LibraryCommand {
	if (type === 'movie') {
		// A movie's watched state is its status, so a set bit means Marquee has it completed.
		return {
			type,
			id: item._id,
			removed: false,
			...(watched.length > 0 ? { status: 'completed' } : {})
		};
	}

	const episodes = watched
		.map((key) => episodeOf(item._id, key))
		.filter((coordinate) => coordinate !== null)
		.map((coordinate) => ({ ...coordinate, watched: true }));

	return { type, id: item._id, removed: false, ...(episodes.length > 0 ? { episodes } : {}) };
}

/**
 * The watched set a serialized bitfield names, or null when it cannot be read against `keys`.
 *
 * The format is `{lastVideoId}:{length}:{buffer}` — a universe, its size and the bits over it. `keys`
 * has to hold the video it ends at, or the library resizes to a blank field instead of raising,
 * which would read as "nothing watched". And it has to be at least as long as the stored field:
 * a shorter catalogue would drop bits while still reporting a set.
 */
function readWatched(serialized: string | undefined, keys: string[]): string[] | null {
	// An item never played carries no bitfield at all: nothing is watched, rather than unknown.
	if (serialized === '') return [];
	// Absent, or not a string: a body that is not the shape this module reads, never a crash.
	if (typeof serialized !== 'string') return null;

	const parts = serialized.split(':');
	if (parts.length < 3) return null;
	if (!keys.includes(parts.slice(0, -2).join(':'))) return null;

	// Shorter is the catalogue growing at the back, which the field is designed to absorb; longer is
	// a universe we do not have, where reading would mean dropping bits we cannot see.
	const length = Number(parts[parts.length - 2]);
	if (!Number.isInteger(length) || length > keys.length) return null;

	try {
		const field = watchedBitfield.constructAndResize(serialized, keys);
		return keys.filter((key) => field.getVideo(key));
	} catch {
		return null;
	}
}

/** Serializes a watched set against the catalogue ordering, which is what gives the bits meaning. */
function encode(keys: string[], watched: string[]): string {
	const set = new Set(watched);
	return watchedBitfield
		.constructFromArray(
			keys.map((key) => set.has(key)),
			keys
		)
		.serialize();
}

/** Same tombstone flag and same watched set. Order is the catalogue's, so compare as sets. */
function agrees(a: SnapshotItem, b: SnapshotItem): boolean {
	if (a.removed !== b.removed || a.watched.length !== b.watched.length) return false;
	const set = new Set(a.watched);
	return b.watched.every((key) => set.has(key));
}

/** `tt…:2:5` → the coordinate Marquee's command vocabulary speaks. Anything else names no episode. */
function episodeOf(id: string, key: string): { season: number; episode: number } | null {
	if (!key.startsWith(`${id}:`)) return null;

	const [season, episode, ...extra] = key.slice(id.length + 1).split(':');
	if (extra.length > 0 || season === undefined || episode === undefined) return null;
	// Digits only: `Number('')` is 0 and `Number('0x2')` is 2, so coercion alone accepts both.
	if (!/^\d+$/.test(season) || !/^\d+$/.test(episode)) return null;

	const coordinate = { season: Number(season), episode: Number(episode) };
	// Season 0 is TMDB's Specials, so only the episode within a season is 1-based.
	return coordinate.episode < 1 ? null : coordinate;
}
