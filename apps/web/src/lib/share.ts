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

// `cancelled` is the user dismissing the sheet — nothing is copied behind it; `failed` means no route worked.
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

// Runs beside the sheet, not in front of it: the tap must be answered now, and `navigator.share` wants the user activation that waiting would risk.
export const WARM_TIMEOUT_MS = 1500;

/** How a warm ended: `timeout` may still land server-side, so it isn't the same news as `failed`. */
export type WarmOutcome = 'stored' | 'timeout' | 'failed';

export interface ShareReport {
	outcome: ShareOutcome;
	warmed: WarmOutcome;
}

export async function shareAndWarm(
	content: ShareContent,
	target: ShareWarmTarget | undefined,
	impls: { warm?: typeof warmPreview; share?: typeof shareLink } = {}
): Promise<ShareReport> {
	const warming = target
		? (impls.warm ?? warmPreview)(target)
		: Promise.resolve<WarmOutcome>('stored');
	const outcome = await (impls.share ?? shareLink)(content);
	return { outcome, warmed: await warming };
}

// Only the server calls TMDB, behind a session — that separation is what stops a crawler spending provider quota.
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
