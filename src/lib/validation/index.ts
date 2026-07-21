/**
 * Shared input validation — the app's DTO primitives. Client-safe (no server-only
 * imports), so the same rules drive immediate client-side feedback and the
 * authoritative server-side re-check (per the validate-on-both-sides convention).
 *
 * Endpoints/actions compose these fields into per-request schemas; JSON API
 * endpoints surface failures as problem+json (see `$lib/server/http/problem`),
 * form actions keep their inline `fail({ ... })` shape.
 */
import { z } from 'zod';

/** Normalize an email for storage/lookup: trim surrounding whitespace and lowercase. */
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/** Permissive email shape; a 6-digit OTP for the sign-in and email-change flows. */
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const CODE_REGEX = /^\d{6}$/;

/** A user-entered email address (trimmed, permissive shape). */
export const emailField = z.string().trim().regex(EMAIL_REGEX, 'Enter a valid email address.');

/** A 6-digit one-time code. */
export const codeField = z.string().trim().regex(CODE_REGEX, 'Enter the 6-digit code.');

/**
 * Sign-in delivery context (installed PWA vs browser tab). Unknown/missing values
 * fall back to `browser`, so a tampered field can't break the request.
 */
export const signInModeField = z.enum(['standalone', 'browser']).catch('browser');

/** First validation message for a field (or the whole value when `field` is omitted). */
export function firstError(error: z.ZodError, field?: string): string | undefined {
	const issue = field ? error.issues.find((i) => i.path[0] === field) : error.issues[0];
	return issue?.message;
}
