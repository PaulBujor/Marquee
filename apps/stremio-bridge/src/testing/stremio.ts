/**
 * Doubles for everything outside this repo's control: Stremio's account API and the
 * requests its addon client makes to us.
 *
 * Shapes follow stremio-core's own source (`src/types/api/{request,response}.rs`,
 * `src/types/library/library_item.rs`). Where a field's wire name is still unconfirmed
 * that is called out inline — the spike against a real account is what settles it.
 */
import watchedBitfieldPackage from 'stremio-watched-bitfield';

/** Stremio's answer when the account has sync turned off — including for an unknown key. */
const SYNC_DISABLED = { code: 5992, message: 'Sync disabled' } as const;

export type LibraryItemType = 'movie' | 'series' | 'channel' | 'tv';

export interface LibraryItemState {
	lastWatched?: string;
	timeWatched?: number;
	timeOffset?: number;
	overallTimeWatched?: number;
	timesWatched?: number;
	flaggedWatched?: number;
	duration?: number;
	videoId: string;
	/** Serialized watched bitfield — build it with `watchedBitfield()`, never by hand. */
	watched: string;
	lastVidReleased?: string;
	noNotif?: boolean;
}

export interface LibraryItemBehaviorHints {
	defaultVideoId?: string;
	featuredVideoId?: string;
	hasScheduledVideos: boolean;
}

export interface LibraryItem {
	_id: string;
	name: string;
	type: LibraryItemType;
	poster?: string;
	posterShape?: 'poster' | 'landscape' | 'square';
	removed: boolean;
	temp: boolean;
	_ctime?: string;
	_mtime?: string;
	state: LibraryItemState;
	behaviorHints?: LibraryItemBehaviorHints;
}

type StateOverrides = Partial<Omit<LibraryItemState, 'watched'>> & { watched?: Iterable<string> };

/** A library item as Stremio stores it, defaulting to an unwatched movie. */
export function libraryItem(
	overrides: Partial<Omit<LibraryItem, 'state'>> & { state?: StateOverrides } = {}
): LibraryItem {
	const _id = overrides._id ?? 'tt0133093';
	const { watched = [], videoId = _id, ...state } = overrides.state ?? {};

	return {
		_id,
		name: 'The Matrix',
		type: 'movie',
		poster: `https://images.metahub.space/poster/medium/${_id}/img`,
		posterShape: 'poster',
		removed: false,
		temp: false,
		_ctime: '2024-01-01T00:00:00.000Z',
		_mtime: '2024-01-01T00:00:00.000Z',
		...overrides,
		state: {
			...state,
			videoId,
			// A movie is indexed by its single video; a series with episodes must pass its
			// episode keys through `state.watched` instead of relying on this default.
			watched: watchedBitfield([videoId]).encode(watched)
		}
	};
}

/**
 * Encodes a watched set into `libraryItem.state.watched` and reads it back.
 * `keys` is the ordered video-id universe the bitfield is indexed by (`tt123:1:1` …).
 */
export function watchedBitfield(keys: string[]) {
	return {
		encode(watched: Iterable<string>): string {
			const set = new Set(watched);
			return watchedBitfieldPackage
				.constructFromArray(
					keys.map((key) => set.has(key)),
					keys
				)
				.serialize();
		},
		decode(serialized: string): string[] {
			const field = watchedBitfieldPackage.constructAndResize(serialized, keys);
			return keys.filter((key) => field.getVideo(key));
		}
	};
}

export type AddonAction = 'libraryAdd' | 'libraryRemove' | 'watched' | 'unwatched';

export interface AddonEventOptions {
	handle: string;
	type: 'movie' | 'series';
	id: string;
	action: AddonAction;
	/** `tt123:season:episode` for a series whose item id is `tt123`. */
	videoId?: string;
	origin?: string;
	/**
	 * Stremio sends the extra props as a path segment, so that is the default. `query` stays
	 * expressible: the protocol allows both, and a client change would surface there first.
	 */
	extra?: 'path' | 'query';
}

/** The request Stremio's addon client makes when the user acts on a library item. */
export function addonEventRequest(options: AddonEventOptions): Request {
	const extra = new URLSearchParams({ action: options.action });
	if (options.videoId) extra.set('videoId', options.videoId);

	const path = `${options.origin ?? 'https://bridge.test'}/${options.handle}/library/${options.type}/${options.id}`;

	return new Request(options.extra === 'query' ? `${path}.json?${extra}` : `${path}/${extra}.json`);
}

export interface AccountRequest {
	url: string;
	body: Record<string, unknown>;
}

export interface StremioAccountApi {
	/** A drop-in for the bridge's `fetch` dependency. */
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
	/** Every request the code under test made, in order. */
	requests: AccountRequest[];
}

export interface StremioAccountOptions {
	authKey?: string;
	email?: string;
	password?: string;
	items?: LibraryItem[];
}

/**
 * Stremio's account API over in-memory library state. Application errors — including an
 * unknown `authKey` — answer HTTP 200 with an `error` envelope, exactly as the real API does.
 */
export function stremioAccountApi(options: StremioAccountOptions = {}): StremioAccountApi {
	const authKey = options.authKey ?? 'marquee-test-auth-key';
	const email = options.email ?? 'user@example.com';
	const password = options.password ?? 'correct-horse-battery-staple';

	const collections = new Map<string, Map<string, LibraryItem>>([['libraryItem', new Map()]]);
	const library = collections.get('libraryItem')!;
	for (const item of options.items ?? []) library.set(item._id, item);

	const requests: AccountRequest[] = [];
	let lastModified = new Date(0).toISOString();

	const ok = (result: unknown) => Response.json({ result });
	const fail = (error: { code: number; message: string }) => Response.json({ error });

	const collection = (body: Record<string, unknown>): Map<string, LibraryItem> => {
		const name = String(body.collection ?? 'libraryItem');
		if (!collections.has(name)) collections.set(name, new Map());
		return collections.get(name)!;
	};

	async function handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const request = input instanceof Request ? input : new Request(input, init);
		const body = (await request.json()) as Record<string, unknown>;
		requests.push({ url: request.url, body });

		switch (new URL(request.url).pathname.split('/').pop()) {
			case 'login':
				// Unconfirmed: the real failure code for a bad password is not documented here.
				if (body.password !== password) return fail({ code: 401, message: 'Incorrect password' });
				return ok({ authKey, user: { _id: 'marquee-test-user', email } });

			case 'datastoreMeta':
				if (body.authKey !== authKey) return fail(SYNC_DISABLED);
				return ok({ changed: collection(body).size > 0, lastModified });

			case 'datastoreGet': {
				if (body.authKey !== authKey) return fail(SYNC_DISABLED);
				const items = collection(body);
				const ids = Array.isArray(body.ids) ? (body.ids as string[]) : undefined;
				if (body.all === true || !ids) return ok([...items.values()]);
				return ok(ids.map((id) => items.get(id)).filter(Boolean));
			}

			case 'datastorePut': {
				if (body.authKey !== authKey) return fail(SYNC_DISABLED);
				const items = collection(body);
				const changes = (body.changes ?? []) as LibraryItem[];
				for (const item of changes) items.set(item._id, item);
				if (changes.length > 0) lastModified = new Date().toISOString();
				return ok(true);
			}

			default:
				return new Response(JSON.stringify({ error: { code: 404, message: 'Not found' } }), {
					status: 404
				});
		}
	}

	return { fetch: handle, requests };
}
