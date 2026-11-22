/** Server-only. SvelteKit form actions keep their own `fail({ message })` contract instead. */
import type { ZodError } from 'zod';

export interface ProblemFieldError {
	/** Dotted path to the offending field, e.g. `events.0.payload.status`. */
	field: string;
	message: string;
}

export interface ProblemDetails {
	type: string;
	title: string;
	status: number;
	detail?: string;
	errors?: ProblemFieldError[];
}

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

export function zodProblem(error: ZodError, title = 'Validation failed'): Response {
	const errors: ProblemFieldError[] = error.issues.map((issue) => ({
		field: issue.path.join('.') || '(root)',
		message: issue.message
	}));
	return problem(400, title, { detail: 'The request body failed validation.', errors });
}
