/**
 * RFC 7807 `application/problem+json` responses. Validation failures return a
 * machine-readable problem document with a collected list of field errors, so a
 * client can surface every issue at once instead of one-at-a-time.
 *
 * Server-only. This is the shared shape the app's JSON API endpoints return on
 * 4xx; SvelteKit form actions keep their own `fail({ message })` contract.
 */
import type { ZodError } from 'zod';

/** A single field-level validation error. */
export interface ProblemFieldError {
	/** Dotted path to the offending field, e.g. `events.0.payload.status`. */
	field: string;
	message: string;
}

/** An RFC 7807 problem document (a subset — enough for this app's needs). */
export interface ProblemDetails {
	type: string;
	title: string;
	status: number;
	detail?: string;
	errors?: ProblemFieldError[];
}

/** Build an `application/problem+json` response. */
export function problem(
	status: number,
	title: string,
	options: { detail?: string; errors?: ProblemFieldError[]; type?: string } = {}
): Response {
	const body: ProblemDetails = { type: options.type ?? 'about:blank', title, status };
	if (options.detail) body.detail = options.detail;
	if (options.errors) body.errors = options.errors;
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/problem+json; charset=utf-8' }
	});
}

/** Turn a `ZodError` into a 400 problem response, collecting every issue as a field error. */
export function zodProblem(error: ZodError, title = 'Validation failed'): Response {
	const errors: ProblemFieldError[] = error.issues.map((issue) => ({
		field: issue.path.join('.') || '(root)',
		message: issue.message
	}));
	return problem(400, title, { detail: 'The request body failed validation.', errors });
}
