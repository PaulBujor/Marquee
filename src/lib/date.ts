// Epoch-ms instants are counted in the local calendar; date-only strings like air dates are formatted in UTC at their call sites.

const absoluteFmt = new Intl.DateTimeFormat(undefined, {
	day: 'numeric',
	month: 'short',
	year: 'numeric'
});

const exactFmt = new Intl.DateTimeFormat(undefined, {
	dateStyle: 'long',
	timeStyle: 'short'
});

/** Positive when `ms` is in the past. */
function daysAgo(ms: number, now: number): number {
	const then = new Date(ms);
	const today = new Date(now);
	const thenMidnight = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
	const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
	return Math.round((todayMidnight - thenMidnight) / 86_400_000);
}

// A future timestamp reads as "Today": event clocks come from whichever device minted them, so a peer running fast can be ahead of us.
export function formatRelativeDay(ms: number, now: number = Date.now()): string {
	const days = daysAgo(ms, now);
	if (days <= 0) return 'Today';
	if (days === 1) return 'Yesterday';
	if (days < 7) return `${days} days ago`;
	return absoluteFmt.format(new Date(ms));
}

export function formatExactDateTime(ms: number): string {
	return exactFmt.format(new Date(ms));
}
