/**
 * Shape and pure helpers for the client error log — the record behind the "something went wrong"
 * toast, kept so an error is still readable after the toast has gone.
 *
 * Split from the rune (`errors.svelte.ts`) the same way the sync log is, so the capping, folding
 * and formatting are testable without a browser.
 */

/** One captured error. `at` is epoch ms. */
export interface ClientErrorEntry {
	at: number;
	message: string;
	/** Where it came from — a route id, `'window.error'`, `'sync'`, a feature tag. */
	source?: string;
	stack?: string;
	/** Path only; the query string is dropped before a report ever leaves the browser. */
	url?: string;
	status?: number;
	/**
	 * How many times this same error has been seen. A render loop or a retrying timer throws the
	 * same thing repeatedly, and a log that lists it 400 times is unreadable — and would push the
	 * one error you actually need off the end.
	 */
	count: number;
}

/**
 * How many distinct errors to keep. Deep enough that a first failure is still there after the
 * cascade it caused, shallow enough to stay readable and to fit in sessionStorage.
 */
export const MAX_ERRORS = 25;

/** Two reports are the same error when they came from the same place saying the same thing. */
function sameError(a: ClientErrorEntry, b: ClientErrorEntry): boolean {
	return a.message === b.message && a.source === b.source;
}

/**
 * Add an entry, newest first, folding a repeat into the existing one rather than appending. The
 * fold bumps `count` and refreshes `at`, so a recurring error keeps showing when it last happened
 * without burying everything else.
 */
export function appendError(
	entries: ClientErrorEntry[],
	entry: ClientErrorEntry
): ClientErrorEntry[] {
	const existing = entries.findIndex((e) => sameError(e, entry));
	if (existing !== -1) {
		const folded = { ...entries[existing], at: entry.at, count: entries[existing].count + 1 };
		// Move it back to the top: the newest occurrence is the one worth seeing first.
		return [folded, ...entries.slice(0, existing), ...entries.slice(existing + 1)];
	}
	return [entry, ...entries].slice(0, MAX_ERRORS);
}

/** `14:22:03`, local time — the log is read next to a user's own memory of when it happened. */
export function formatTime(at: number): string {
	return new Date(at).toLocaleTimeString(undefined, {
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	});
}

/** The whole log as plain text, for the copy button — what a bug report should be pasted from. */
export function formatErrorText(entries: ClientErrorEntry[]): string {
	if (entries.length === 0) return 'No errors recorded.';
	return entries
		.map((e) => {
			const head = [
				formatTime(e.at),
				e.source ? `[${e.source}]` : null,
				e.count > 1 ? `(×${e.count})` : null,
				e.message
			]
				.filter(Boolean)
				.join(' ');
			const detail = [
				e.url ? `  at ${e.url}` : null,
				e.status !== undefined ? `  status ${e.status}` : null,
				e.stack ? e.stack.replace(/^/gm, '  ') : null
			].filter(Boolean);
			return [head, ...detail].join('\n');
		})
		.join('\n\n');
}

/** Restore a persisted log, tolerating anything that isn't one. */
export function parseErrors(raw: string | null): ClientErrorEntry[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter(
				(e): e is ClientErrorEntry =>
					typeof e === 'object' &&
					e !== null &&
					typeof (e as ClientErrorEntry).message === 'string' &&
					typeof (e as ClientErrorEntry).at === 'number'
			)
			.map((e) => ({ ...e, count: typeof e.count === 'number' ? e.count : 1 }))
			.slice(0, MAX_ERRORS);
	} catch {
		return [];
	}
}
