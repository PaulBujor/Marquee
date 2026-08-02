/**
 * Data import: rebuild a library from an export file.
 *
 * Writes **events**, not state — they land in the outbox and the local projection, then ordinary
 * sync pushes them. Hence no import endpoint and no server-side import code: restoring an account
 * is an unusually large sync, and it works offline for the same reason.
 *
 * Client-safe (browser only).
 */
import { applyEventsToIdb, enqueueEvents, getDeviceId, putMedia } from '$lib/client/idb';
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
		// Only the reasons that suggest *we* have a problem: a wrong file is a UI message, but
		// something claiming to be our export failing our schema means the two have drifted.
		if (parsed.reason === 'invalid' || parsed.reason === 'unsupported_version') {
			reportClientError({
				message: `import rejected a Marquee export: ${parsed.reason}`,
				source: 'import.read',
				at: Date.now()
			});
		}
		return { ok: false, reason: parsed.reason };
	}
	return { ok: true, plan: planImport(parsed.doc, await getDeviceId()) };
}

/**
 * Apply a plan: seed the media stubs, queue the events, and project them locally so the library
 * updates immediately. Then nudge sync to start pushing.
 *
 * Additive — nothing local is cleared. Every event carries its recorded clock, so importing into
 * an account that already has data merges by last-write-wins.
 *
 * A part-way failure leaves what already landed; every write is an idempotent upsert, so
 * re-running converges. `plan` must be **plain data** — a Svelte `$state` value hands IndexedDB a
 * Proxy, which structured clone refuses.
 */
export async function applyImport(plan: ImportPlan): Promise<void> {
	// Report and rethrow — the UI still shows the failure, but a silent one on someone else's
	// device is exactly what we can't debug without a log line.
	try {
		// Media first, so the channel can start hydrating the real rows while events sync.
		for (const record of plan.media) await putMedia(record);

		await enqueueEvents(plan.events);
		// One transaction for the whole batch — a library's worth of events applied one at a time
		// would be thousands of round trips with the UI blocked behind them.
		await applyEventsToIdb(plan.events);
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
