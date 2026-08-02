/**
 * Data import: rebuild a library from an export file.
 *
 * The import writes **events**, not state — the same events a user clicking through the UI would
 * have produced, just fewer of them. They land in the outbox and the local projection, then the
 * ordinary sync engine pushes them to the server, which projects them like any other change. So
 * there is no import endpoint and no server-side import code: restoring an account is just an
 * unusually large sync.
 *
 * It also works offline. Everything is written locally and drains whenever a connection returns.
 *
 * Client-safe (browser only).
 */
import { applyEventToIdb, enqueueEvents, getDeviceId, putMedia } from '$lib/client/idb';
import { reportClientError } from '$lib/client/report-error';
import { sync } from '$lib/client/sync/engine.svelte';
import { parseExport, type ParseFailure } from '$lib/portability/parse';
import { planImport, type ImportPlan } from '$lib/portability/plan';

export type { ParseFailure };

/** Human-readable reason a file was rejected, for display next to the picker. */
export function parseFailureMessage(reason: ParseFailure): string {
	switch (reason) {
		case 'not_json':
			return "That file isn't valid JSON — it may be incomplete or corrupted.";
		case 'wrong_format':
			return "That doesn't look like a Marquee export.";
		case 'unsupported_version':
			return 'That export was made by a newer version of Marquee. Update the app and try again.';
		default:
			return "That export is missing data we need — we couldn't read it.";
	}
}

export type ReadResult = { ok: true; plan: ImportPlan } | { ok: false; reason: ParseFailure };

/**
 * Read and validate a file, returning what an import *would* do. Writes nothing — the caller shows
 * the counts and asks the user to confirm before {@link applyImport}.
 */
export async function readImportFile(file: File): Promise<ReadResult> {
	const parsed = parseExport(await file.text());
	if (!parsed.ok) {
		// A rejected file is usually the user's mistake, not a bug — but it's also the only signal we
		// get when our own export stops round-tripping, so it's worth a line in the log.
		reportClientError({
			message: `import rejected a file: ${parsed.reason}`,
			source: 'import.read',
			at: Date.now()
		});
		return { ok: false, reason: parsed.reason };
	}
	return { ok: true, plan: planImport(parsed.doc, await getDeviceId()) };
}

/**
 * Apply a plan: seed the media stubs, queue the events, and project them locally so the library
 * updates immediately. Then nudge sync to start pushing.
 *
 * Additive — no `tracking.removed` is emitted and nothing local is cleared. Because the events
 * carry the exported `addedAt` as their clock, importing into an account that already has data
 * merges by last-write-wins: anything changed since the export was taken is newer, and wins.
 *
 * A failure part-way through leaves whatever already landed in place. That's safe rather than
 * tidy: every write is an idempotent last-write-wins upsert, so re-running the same import
 * converges on the same state.
 *
 * `plan` must be **plain data**. Passing a Svelte `$state` value hands IndexedDB a Proxy, which
 * structured clone refuses — keep the plan out of reactive state, or snapshot it first.
 */
export async function applyImport(plan: ImportPlan): Promise<void> {
	// The catch reports and rethrows: the UI still needs to show a failure, but a silent import
	// failure on someone else's device is exactly what we can't debug without a log line.
	try {
		// Media first, so the channel can start hydrating the real rows while events sync.
		for (const record of plan.media) await putMedia(record);

		await enqueueEvents(plan.events);
		for (const event of plan.events) await applyEventToIdb(event);
	} catch (err) {
		reportClientError({
			message:
				`import failed applying ${plan.counts.titles} titles / ` +
				`${plan.events.length} events / ${plan.media.length} media: ` +
				(err instanceof Error ? err.message : String(err)),
			stack: err instanceof Error ? err.stack : undefined,
			source: 'import.apply',
			at: Date.now()
		});
		throw err;
	}

	sync.requestSync();
}
