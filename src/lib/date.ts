/**
 * Date formatting for user-activity timestamps — the single client-safe source of truth
 * (pure, no dependencies) shared by the detail page and the library.
 *
 * These are real epoch-ms instants (event clocks), so days are counted in the **local**
 * calendar. Date-only strings like TMDB air dates are a different problem — they're
 * formatted in UTC at their call sites so a timezone can't shift the day.
 */

/** Absolute form once a timestamp is too old to read as relative, e.g. "12 Jul 2026". */
const absoluteFmt = new Intl.DateTimeFormat(undefined, {
	day: 'numeric',
	month: 'short',
	year: 'numeric'
});

/** Full date + time, for the tooltip that disambiguates a relative label. */
const exactFmt = new Intl.DateTimeFormat(undefined, {
	dateStyle: 'long',
	timeStyle: 'short'
});

/** Whole local calendar days between two instants (positive when `ms` is in the past). */
function daysAgo(ms: number, now: number): number {
	const then = new Date(ms);
	const today = new Date(now);
	const thenMidnight = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
	const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
	return Math.round((todayMidnight - thenMidnight) / 86_400_000);
}

/**
 * A timestamp as "Today" / "Yesterday" / "N days ago" within the past week, and the absolute
 * date beyond it — recent activity reads better relative, older activity better dated.
 *
 * A timestamp in the *future* reads as "Today": event clocks come from whichever device minted
 * them, so a peer running fast can hand us a `clientCreatedAt` slightly ahead of ours.
 */
export function formatRelativeDay(ms: number, now: number = Date.now()): string {
	const days = daysAgo(ms, now);
	if (days <= 0) return 'Today';
	if (days === 1) return 'Yesterday';
	if (days < 7) return `${days} days ago`;
	return absoluteFmt.format(new Date(ms));
}

/** The unabbreviated date + time, e.g. "12 July 2026 at 21:04" — the `title` behind a relative label. */
export function formatExactDateTime(ms: number): string {
	return exactFmt.format(new Date(ms));
}
