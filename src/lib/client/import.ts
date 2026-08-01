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
	if (!parsed.ok) return { ok: false, reason: parsed.reason };
	return { ok: true, plan: planImport(parsed.doc, await getDeviceId()) };
}

/**
 * Apply a plan: seed the media stubs, queue the events, and project them locally so the library
 * updates immediately. Then nudge sync to start pushing.
 *
 * Additive — no `tracking.removed` is emitted and nothing local is cleared. Because the events
 * carry the exported `addedAt` as their clock, importing into an account that already has data
 * merges by last-write-wins: anything changed since the export was taken is newer, and wins.
 */
export async function applyImport(plan: ImportPlan): Promise<void> {
	// Media first, so the channel can start hydrating the real rows while events sync.
	for (const record of plan.media) await putMedia(record);

	await enqueueEvents(plan.events);
	for (const event of plan.events) await applyEventToIdb(event);

	sync.requestSync();
}
