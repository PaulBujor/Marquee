import type { HandleClientError } from '@sveltejs/kit';
import { reportClientError } from '$lib/client/report-error';

/**
 * Central capture for **unexpected** client-side errors (uncaught throws during navigation /
 * rendering). Mirrors the server `handleError` hook: forward a structured report to the
 * observability sink (`/api/client-error`) and return a generic message for the UI. Best-effort —
 * `reportClientError` swallows its own failures, so this hook never throws.
 */
export const handleError: HandleClientError = ({ error, event }) => {
	reportClientError({
		message: error instanceof Error ? error.message : String(error),
		stack: error instanceof Error ? error.stack : undefined,
		source: event.route?.id ?? event.url.pathname,
		url: event.url.href,
		at: Date.now()
	});
	return { message: 'Something went wrong.' };
};
