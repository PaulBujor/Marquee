/**
 * Auth-local re-export of the shared validation primitives. The canonical home is
 * the client-safe `$lib/validation` module; this keeps the existing `./validation`
 * import path stable for the auth code.
 */
export { normalizeEmail, EMAIL_REGEX, CODE_REGEX } from '$lib/validation';
