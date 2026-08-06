import { buildPushHTTPRequest, type PushMessage } from '@pushforge/builder';
import { fetchWithTimeout } from '$lib/resilience';
import type { PushPayload, PushResult, PushSender, PushTarget } from './index';

/**
 * Wall-clock budget per push. The digest sends serially across every due user, so one
 * unresponsive push service must not be able to stall the whole run.
 */
const PUSH_TIMEOUT_MS = 10_000;

/**
 * Web Push transport backed by `@pushforge/builder` — a zero-dependency, Web-Crypto
 * implementation of VAPID (RFC 8292) + `aes128gcm` payload encryption (RFC 8291) that runs on
 * workerd (the Node `web-push` package does not). `buildPushHTTPRequest` produces the signed,
 * encrypted request; we send it ourselves so the caller controls `fetch`.
 */
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
			// PushPayload is JSON-serialisable, but a fixed-shape interface can't structurally satisfy
			// the library's `Jsonifiable` index-signature constraint — cast at the boundary.
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
			// Report a stall or network failure as a plain non-ok result rather than throwing: the
			// digest loops over every due user, and one bad endpoint must not abort the run. Not
			// `gone` — the subscription may be fine, so it is retried next sweep rather than deleted.
			console.error('push send failed:', err);
			return { ok: false, status: 0, gone: false };
		}
		// Push services return 404/410 once a subscription is expired/unsubscribed — the caller
		// deletes those rows so future sweeps stop targeting them.
		return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
	}
}
