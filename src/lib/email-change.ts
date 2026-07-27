/**
 * Client-safe email-change config. The TTL is shown in the settings UI (a universal load reads it,
 * so it must not pull server code) and enforced by the server (`$lib/server/auth/email-change`
 * imports it from here). Keep it here as the single source of truth.
 */
export const EMAIL_CHANGE_TTL_MINUTES = 10;
