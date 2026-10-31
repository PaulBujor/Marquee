/**
 * An abort is a cancelled operation, never a defect: a superseded navigation, a backgrounded page, or
 * a request that outlived its timeout. Checked by name rather than by type because `DOMException`
 * only joined the `Error` hierarchy recently, and a rejection reason is not required to be an Error.
 */
export function isAbortError(reason: unknown): boolean {
	return (
		typeof reason === 'object' &&
		reason !== null &&
		(reason as { name?: unknown }).name === 'AbortError'
	);
}
