/**
 * An uncaught rejection in an event handler reaches neither the user nor `/api/client-error`.
 */
import { toast } from 'svelte-sonner';
import { reportClientError } from './report-error';

export interface WriteGuardContext {
	/** Format: `custom-media:create`. */
	source: string;
	userMessage: string;
}

/**
 * **Returns false rather than throwing**, so the caller can skip whatever should only happen on
 * success (closing a dialog, navigating away) without its own try/catch.
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
