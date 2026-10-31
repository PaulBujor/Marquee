// DOMException only joined the Error hierarchy recently, and a rejection reason need not be an Error at all.
export function isAbortError(reason: unknown): boolean {
	return (
		typeof reason === 'object' &&
		reason !== null &&
		(reason as { name?: unknown }).name === 'AbortError'
	);
}
