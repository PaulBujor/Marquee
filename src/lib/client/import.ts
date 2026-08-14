/**
 * Data import: rebuild a library from an export file. Writes events (not state), which land in the
 * outbox and sync normally. Works offline. Client-safe.
 */
import {
	applyEventsToIdb,
	enqueueEvents,
	getDeviceId,
	putCustomMedia,
	putMediaBatch
} from '$lib/client/idb';
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

/** Dry-run: parse a file and return what an import would do, without writing anything. */
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
 * Apply a plan: seed media, queue events, and project locally. Additive — nothing local is cleared.
 * `plan` must be plain data (not `$state`).
 */
export async function applyImport(plan: ImportPlan): Promise<void> {
	// Report and rethrow — UI shows the failure; this log covers silent ones on other devices.
	try {
		// Media first — batched so the channel hydrates while events sync.
		await putMediaBatch(plan.media.filter((m) => m.source !== 'custom'));

		// Custom entries through the authoring write — each queued for backup.
		for (const record of plan.media.filter((m) => m.source === 'custom')) {
			await putCustomMedia(record);
		}

		await enqueueEvents(plan.events);
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
