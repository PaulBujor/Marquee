// Client-only Web Push state — mirrors the ThemeState / PwaState singleton pattern.
// Source of truth for "is this device subscribed" is the live `pushManager.getSubscription()`;
// we only persist the one-time "already asked" flag (localStorage), like the install prompt.

import { getDeviceId } from '$lib/client/idb';
import { deviceLabel, urlBase64ToUint8Array } from './notifications-util';

const ASKED_KEY = 'marquee:notify-asked';

/** Feature detection — everything degrades silently where Web Push isn't available (e.g. iOS Safari). */
function detectSupported(): boolean {
	return (
		typeof window !== 'undefined' &&
		'Notification' in window &&
		'PushManager' in window &&
		'serviceWorker' in navigator
	);
}

class NotificationsState {
	readonly supported = detectSupported();
	permission = $state<NotificationPermission>(this.supported ? Notification.permission : 'denied');
	/** Whether this device currently holds a push subscription (from `getSubscription()`). */
	subscribed = $state(false);
	/** This device's current push endpoint, to mark it in the settings device list. */
	endpoint = $state<string | null>(null);
	busy = $state(false);
	error = $state<string | null>(null);
	/** The transient contextual opt-in banner (shown once, on a first "watching"). */
	contextualPrompt = $state(false);
	#asked = this.#readAsked();

	constructor() {
		if (this.supported) void this.refresh();
	}

	#readAsked(): boolean {
		if (typeof localStorage === 'undefined') return true;
		return localStorage.getItem(ASKED_KEY) === '1';
	}

	#markAsked(): void {
		this.#asked = true;
		if (typeof localStorage !== 'undefined') localStorage.setItem(ASKED_KEY, '1');
	}

	/** Re-read permission + subscription state (e.g. on settings open). */
	async refresh(): Promise<void> {
		if (!this.supported) return;
		this.permission = Notification.permission;
		try {
			const reg = await navigator.serviceWorker.ready;
			const subscription = await reg.pushManager.getSubscription();
			this.subscribed = subscription !== null;
			this.endpoint = subscription?.endpoint ?? null;
		} catch {
			this.subscribed = false;
			this.endpoint = null;
		}
	}

	/** Show the one-time contextual opt-in when a title first becomes "watching" (fire-and-forget). */
	promptContextually(): void {
		if (!this.supported || this.#asked || this.permission !== 'default' || this.subscribed) return;
		this.contextualPrompt = true;
	}

	/** Dismiss the contextual banner without enabling — don't ask again. */
	dismissContextual(): void {
		this.contextualPrompt = false;
		this.#markAsked();
	}

	/**
	 * Request permission, subscribe via the VAPID key, and register the subscription server-side.
	 * Returns whether notifications ended up enabled. Idempotent-ish: safe to call when already on.
	 */
	async enable(): Promise<boolean> {
		if (!this.supported) return false;
		this.busy = true;
		this.error = null;
		this.contextualPrompt = false;
		this.#markAsked();
		try {
			this.permission = await Notification.requestPermission();
			if (this.permission !== 'granted') {
				if (this.permission === 'denied')
					this.error = 'Notifications are blocked — enable them in your browser settings.';
				return false;
			}
			const reg = await navigator.serviceWorker.ready;
			const keyRes = await fetch('/api/push/vapid-key');
			if (!keyRes.ok) throw new Error(`vapid-key ${keyRes.status}`);
			const { publicKey } = (await keyRes.json()) as { publicKey: string };
			const subscription = await reg.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: urlBase64ToUint8Array(publicKey)
			});
			await this.#register(subscription);
			this.subscribed = true;
			this.endpoint = subscription.endpoint;
			return true;
		} catch (err) {
			console.error('notifications: enable failed', err);
			this.error = 'Could not enable notifications. Please try again.';
			return false;
		} finally {
			this.busy = false;
		}
	}

	async #register(subscription: PushSubscription): Promise<void> {
		const json = subscription.toJSON();
		const res = await fetch('/api/push/subscribe', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				endpoint: json.endpoint,
				keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
				deviceId: await getDeviceId(),
				deviceLabel: deviceLabel(
					typeof navigator === 'undefined' ? undefined : navigator.userAgent
				),
				timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
			})
		});
		if (!res.ok) throw new Error(`subscribe ${res.status}`);
	}

	/**
	 * Turn notifications off on this device: unsubscribe locally so the push endpoint is invalidated
	 * immediately. The server row is reaped on the next send (410 → prune), or removed
	 * explicitly from the settings device list.
	 */
	async disable(): Promise<void> {
		if (!this.supported) return;
		this.busy = true;
		this.error = null;
		try {
			const reg = await navigator.serviceWorker.ready;
			const subscription = await reg.pushManager.getSubscription();
			if (subscription) await subscription.unsubscribe();
			this.subscribed = false;
			this.endpoint = null;
		} catch (err) {
			console.error('notifications: disable failed', err);
			this.error = 'Could not turn off notifications.';
		} finally {
			this.busy = false;
		}
	}
}

export const notifications = new NotificationsState();
