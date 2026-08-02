import type { HandleClientError } from '@sveltejs/kit';
import { installGlobalErrorReporting, reportClientError } from '$lib/client/report-error';

/**
 * The catch-all net, installed once when the client module loads. `handleError` below only fires
 * for throws during navigation and rendering, so without this an error from an event handler, a
 * timer or a floating promise would reach nothing but the browser console.
 */
installGlobalErrorReporting();

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
