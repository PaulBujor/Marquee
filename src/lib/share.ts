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
			// Anything else (a blocked or broken sheet) falls through to the clipboard.
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
