import { buildPushHTTPRequest, type PushMessage } from '@pushforge/builder';
import { fetchWithTimeout } from '#lib/resilience.js';
import type { PushPayload, PushResult, PushSender, PushTarget } from './index';

// Serial sends across every due user, so one unresponsive push service must not stall the whole run.
const PUSH_TIMEOUT_MS = 10_000;

// `@pushforge/builder` is VAPID + aes128gcm in Web Crypto, which runs on workerd; Node's `web-push` does not.
export class PushForgeSender implements PushSender {
	constructor(
		/** VAPID private key as a JWK JSON string (from `VAPID_PRIVATE_KEY`). */
		private privateJWK: string,
		/** VAPID `sub` claim — a `mailto:` / URL contact for the push service. */
		private adminContact: string
	) {}

	async send(target: PushTarget, payload: PushPayload): Promise<PushResult> {
		const { endpoint, headers, body } = await buildPushHTTPRequest({
			privateJWK: this.privateJWK,
			subscription: target,
			// A fixed-shape interface can't satisfy the library's `Jsonifiable` index signature — cast at the boundary.
			message: {
				payload: payload as unknown as PushMessage['payload'],
				adminContact: this.adminContact
			}
		});

		let res: Response;
		try {
			res = await fetchWithTimeout(endpoint, {
				method: 'POST',
				headers,
				body,
				timeoutMs: PUSH_TIMEOUT_MS
			});
		} catch (err) {
			// Not `gone`: the subscription may be fine, so retry next sweep rather than deleting it.
			console.error('push send failed:', err);
			return { ok: false, status: 0, gone: false };
		}
		return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
	}
}
