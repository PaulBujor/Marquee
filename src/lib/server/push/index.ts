import { PushForgeSender } from './sender';

/** The encrypted-payload shape delivered to the service worker `push` handler. */
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

/** Outcome of a single send, so callers can prune subscriptions the push service has dropped. */
export interface PushResult {
	ok: boolean;
	status: number;
	/** True when the push service reports the subscription is gone (404/410) — safe to delete. */
	gone: boolean;
}

export interface PushSender {
	send(target: PushTarget, payload: PushPayload): Promise<PushResult>;
}

/**
 * Resolve the Web Push transport. Requires the VAPID key pair (`VAPID_PUBLIC_KEY` is the
 * base64url application-server key; `VAPID_PRIVATE_KEY` is the private key as a JWK JSON string —
 * both produced by `npx @pushforge/builder vapid`). `adminContact` is the VAPID `sub` claim.
 */
export function createPushSender(env: Env): PushSender {
	if (!env.VAPID_PRIVATE_KEY) throw new Error('VAPID_PRIVATE_KEY is not configured');
	if (!env.VAPID_PUBLIC_KEY) throw new Error('VAPID_PUBLIC_KEY is not configured');
	// The VAPID `sub` claim: a contact URI for the push service. Reuse the app's From address.
	const contact = env.EMAIL_FROM
		? `mailto:${extractEmail(env.EMAIL_FROM)}`
		: 'mailto:admin@marquee.app';
	return new PushForgeSender(env.VAPID_PRIVATE_KEY, contact);
}

/** Pull a bare address out of a `Name <addr@host>` (or plain) From string for the `mailto:` sub. */
function extractEmail(from: string): string {
	const match = from.match(/<([^>]+)>/);
	return (match ? match[1] : from).trim();
}
