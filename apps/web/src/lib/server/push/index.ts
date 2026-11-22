import { PushForgeSender } from './sender';

export interface PushPayload {
	title: string;
	body: string;
	/** In-app path to deep-link to when the notification is clicked (e.g. `/title/movie/603`). */
	url: string;
	/** Collapse key — a later notification with the same tag replaces an earlier one. */
	tag?: string;
}

/** The client subscription a push is addressed to (the browser `PushSubscription.toJSON()` shape). */
export interface PushTarget {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

export interface PushResult {
	ok: boolean;
	status: number;
	/** True when the push service reports the subscription is gone (404/410) — safe to delete. */
	gone: boolean;
}

export interface PushSender {
	send(target: PushTarget, payload: PushPayload): Promise<PushResult>;
}

// VAPID keys from `npx @pushforge/builder vapid`: PUBLIC is base64url, PRIVATE a JWK JSON string.
export function createPushSender(env: Env): PushSender {
	if (!env.VAPID_PRIVATE_KEY) throw new Error('VAPID_PRIVATE_KEY is not configured');
	if (!env.VAPID_PUBLIC_KEY) throw new Error('VAPID_PUBLIC_KEY is not configured');
	const contact = env.EMAIL_FROM
		? `mailto:${extractEmail(env.EMAIL_FROM)}`
		: 'mailto:admin@marquee.app';
	return new PushForgeSender(env.VAPID_PRIVATE_KEY, contact);
}

function extractEmail(from: string): string {
	const match = from.match(/<([^>]+)>/);
	return (match ? match[1] : from).trim();
}
