/** Normalize an email for storage/lookup: trim surrounding whitespace and lowercase. */
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/**
 * Shared input shapes, re-validated server-side (the client uses them only for
 * immediate feedback). `EMAIL_REGEX` is a permissive email check; `CODE_REGEX` gates
 * the 6-digit OTP for both sign-in and email-change flows.
 */
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const CODE_REGEX = /^\d{6}$/;
