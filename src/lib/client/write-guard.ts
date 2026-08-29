/**
 * Wrapper for local writes that must not fail silently.
 *
 * An IndexedDB write can fail invisibly (blocked upgrade, quota, private mode), and an uncaught
 * rejection in an event handler reaches neither the user nor `/api/client-error`. Same contract
 * `TrackingState.#run` applies to tracking writes, for the paths that don't go through it.
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
