/**
 * Wrapper for local writes that must not fail silently.
 *
 * A write to IndexedDB can fail for reasons the user has no way to see — a blocked version upgrade,
 * a storage quota, a private-mode restriction. Left uncaught in an event handler the rejection goes
 * nowhere: the dialog closes, the button re-enables, and the user believes their entry was saved.
 * Worse, nothing reaches `/api/client-error`, so it's invisible from our side too.
 *
 * This is the same contract `TrackingState.#run` applies to tracking writes, factored out for the
 * paths that don't go through it.
 *
 * Client-safe (browser only).
 */
import { toast } from 'svelte-sonner';
import { reportClientError } from './report-error';

export interface WriteGuardContext {
	/** Where the failure came from, for the error sink (e.g. `custom-media:create`). */
	source: string;
	/** What the user was trying to do, shown as the toast title (e.g. "Couldn't add that entry"). */
	userMessage: string;
}

/**
 * Run `work`, returning whether it succeeded. On failure it logs, reports, and tells the user —
 * and **returns false rather than throwing**, so the caller can skip whatever should only happen
 * on success (closing a dialog, navigating away) without needing its own try/catch.
 */
export async function guardedWrite(
	work: () => Promise<void>,
	ctx: WriteGuardContext
): Promise<boolean> {
	try {
		await work();
		return true;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`${ctx.source}: write failed`, err);
		reportClientError({
			message: `${ctx.source} failed: ${message}`,
			stack: err instanceof Error ? err.stack : undefined,
			source: ctx.source,
			at: Date.now()
		});
		toast.error(ctx.userMessage, { description: 'Please try again.' });
		return false;
	}
}
