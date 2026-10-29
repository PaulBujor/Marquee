/**
 * Sharing a link out of the app: the OS share sheet where the platform has one (iOS/Android),
 * otherwise the clipboard. The environment is injectable so the fallback logic is testable.
 */

export interface ShareContent {
	title: string;
	text?: string;
	url: string;
}

export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'failed';

export interface ShareEnvironment {
	share?: (content: ShareContent) => Promise<void>;
	canShare?: (content: ShareContent) => boolean;
	writeText?: (text: string) => Promise<void>;
}

interface ShareCapableNavigator {
	share?: (content: ShareContent) => Promise<void>;
	canShare?: (content: ShareContent) => boolean;
}

/** What this browser can do. Empty outside a browser (SSR, tests). */
export function browserShareEnvironment(): ShareEnvironment {
	if (typeof navigator === 'undefined') return {};
	const nav = navigator as unknown as ShareCapableNavigator;
	return {
		share: typeof nav.share === 'function' ? (content) => nav.share!(content) : undefined,
		canShare: typeof nav.canShare === 'function' ? (content) => nav.canShare!(content) : undefined,
		// Absent on an insecure origin, which is why the clipboard route is optional too.
		writeText:
			typeof navigator.clipboard?.writeText === 'function'
				? (text) => navigator.clipboard.writeText(text)
				: undefined
	};
}

/**
 * Share `content`, reporting which route was taken. `cancelled` means the user dismissed the OS
 * sheet — a decision, so nothing is copied behind it; `failed` means no route worked.
 */
export async function shareLink(
	content: ShareContent,
	env: ShareEnvironment = browserShareEnvironment()
): Promise<ShareOutcome> {
	if (env.share && (env.canShare?.(content) ?? true)) {
		try {
			await env.share(content);
			return 'shared';
		} catch (err) {
			if (err instanceof Error && err.name === 'AbortError') return 'cancelled';
		}
	}

	if (!env.writeText) return 'failed';
	try {
		await env.writeText(content.url);
		return 'copied';
	} catch {
		return 'failed';
	}
}

export type ShareWarmTarget = { type: 'movie' | 'show'; id: number };

/**
 * How long a share waits for the preview to be stored before opening the sheet. The recipient's
 * chat app unfurls the link within moments of the share, so the card is worth a short wait — but
 * never a long one, and never a failed share.
 */
export const WARM_TIMEOUT_MS = 1500;

/** How a warm ended: `timeout` may still land server-side, so it isn't the same news as `failed`. */
export type WarmOutcome = 'stored' | 'timeout' | 'failed';

/**
 * Ask the server to store this link's preview so the recipient's app has a page to render.
 * Best-effort by design: a failure, a timeout or being offline still shares the link, just without
 * a guaranteed preview. The server side is the only place that calls TMDB, and it requires a
 * session — that separation is what stops a crawler spending provider quota.
 */
export async function warmPreview(
	target: ShareWarmTarget,
	opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<WarmOutcome> {
	const doFetch = opts.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? WARM_TIMEOUT_MS);
	try {
		const res = await doFetch('/api/share/preview', {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(target),
			signal: controller.signal
		});
		return res.ok ? 'stored' : 'failed';
	} catch (err) {
		return (err as { name?: string })?.name === 'AbortError' ? 'timeout' : 'failed';
	} finally {
		clearTimeout(timer);
	}
}
