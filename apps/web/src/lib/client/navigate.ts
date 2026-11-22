import { goto } from '$app/navigation';
import { reportClientError } from './report-error.js';

/**
 * A superseded navigation rejects with `AbortError` — the next keystroke, or the tab losing focus mid-flight — so
 * those stay silent. Anything else is a real failure and is reported like any other client error.
 */
export function navigate(to: string, options?: Parameters<typeof goto>[1]): Promise<void> {
	// eslint-disable-next-line svelte/no-navigation-without-resolve -- callers pass paths they resolved themselves
	return goto(to, options).catch((error: unknown) => {
		if (error instanceof Error && error.name === 'AbortError') return;
		reportClientError({
			message: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
			source: 'navigate',
			url: to,
			at: Date.now()
		});
	});
}
