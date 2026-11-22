/** `at` is epoch ms. */
export interface ClientErrorEntry {
	at: number;
	message: string;
	/** A route id, `'window.error'`, `'sync'`, a feature tag. */
	source?: string;
	stack?: string;
	/** Path only — the query string is dropped before a report leaves the browser. */
	url?: string;
	status?: number;
	count: number;
}

export const MAX_ERRORS = 25;

function sameError(a: ClientErrorEntry, b: ClientErrorEntry): boolean {
	return a.message === b.message && a.source === b.source;
}

/** A retrying timer throws the same error repeatedly; folding keeps the first failure in the log. */
export function appendError(
	entries: ClientErrorEntry[],
	entry: ClientErrorEntry
): ClientErrorEntry[] {
	const existing = entries.findIndex((e) => sameError(e, entry));
	if (existing !== -1) {
		const folded = { ...entries[existing], at: entry.at, count: entries[existing].count + 1 };
		return [folded, ...entries.slice(0, existing), ...entries.slice(existing + 1)];
	}
	return [entry, ...entries].slice(0, MAX_ERRORS);
}

/** Local time, `14:22:03`. */
export function formatTime(at: number): string {
	return new Date(at).toLocaleTimeString(undefined, {
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	});
}

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

export const TOAST_MAX = 3;
export const TOAST_WINDOW_MS = 30_000;

/** Per-session cap would silence errors for good, so the window lets a later failure speak. */
export function admitToast(recent: number[], now: number): { recent: number[]; show: boolean } {
	const kept = recent.filter((t) => now - t < TOAST_WINDOW_MS);
	if (kept.length >= TOAST_MAX) return { recent: kept, show: false };
	return { recent: [...kept, now], show: true };
}

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
			.map((e) => ({ ...e, count: typeof e.count === 'number' && e.count > 0 ? e.count : 1 }))
			.slice(0, MAX_ERRORS);
	} catch {
		return [];
	}
}
