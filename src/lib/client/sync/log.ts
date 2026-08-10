/** Pure helpers for the sync log — split out so the ring and formatting are testable. */

export type SyncLogLevel = 'info' | 'warn' | 'error';
export type SyncLogChannel = 'cycle' | 'events' | 'media' | 'images' | 'cache';

export interface SyncLogEntry {
	/** Epoch ms. */
	at: number;
	level: SyncLogLevel;
	channel: SyncLogChannel;
	message: string;
}

/** Entries kept in memory — a cycle writes a handful, so this holds a long session. */
export const SYNC_LOG_MAX = 200;

/** Append, newest first, dropping the oldest past `max`. */
export function appendEntry(
	entries: SyncLogEntry[],
	entry: SyncLogEntry,
	max = SYNC_LOG_MAX
): SyncLogEntry[] {
	return [entry, ...entries].slice(0, max);
}

/** `14:22:31`, local. */
export function formatTime(at: number): string {
	return new Date(at).toLocaleTimeString(undefined, { hour12: false });
}

/** The whole log as plain text, oldest first, for the copy button. */
export function formatLogText(entries: SyncLogEntry[]): string {
	return [...entries]
		.reverse()
		.map(
			(e) =>
				`${formatTime(e.at)} [${e.channel}] ${e.level === 'info' ? '' : `${e.level}: `}${e.message}`
		)
		.join('\n');
}

/** Entries recovered from session storage, dropping anything malformed. */
export function parseEntries(raw: string | null): SyncLogEntry[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(e): e is SyncLogEntry =>
				typeof e === 'object' &&
				e !== null &&
				typeof (e as SyncLogEntry).at === 'number' &&
				typeof (e as SyncLogEntry).message === 'string'
		);
	} catch {
		return [];
	}
}
