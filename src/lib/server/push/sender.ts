import { buildPushHTTPRequest, type PushMessage } from '@pushforge/builder';
import type { PushPayload, PushResult, PushSender, PushTarget } from './index';

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

		const res = await fetch(endpoint, { method: 'POST', headers, body });
		// Push services return 404/410 once a subscription is expired/unsubscribed — the caller
		// deletes those rows so future sweeps stop targeting them.
		return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
	}
}
