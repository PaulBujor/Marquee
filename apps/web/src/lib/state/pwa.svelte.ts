// Client-only PWA install state — mirrors the ThemeState singleton pattern.

interface BeforeInstallPromptEvent extends Event {
	prompt(): Promise<void>;
	userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'marquee:install-dismissed';

function detectStandalone(): boolean {
	if (typeof window === 'undefined') return false;
	return (
		window.matchMedia('(display-mode: standalone)').matches ||
		(navigator as unknown as { standalone?: boolean }).standalone === true
	);
}

function detectIOS(): boolean {
	if (typeof navigator === 'undefined') return false;
	const ua = navigator.userAgent;
	// iPadOS 13+ masquerades as a Mac, so also treat touch-capable Macs as iOS.
	return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

class PwaState {
	#deferred: BeforeInstallPromptEvent | null = null;
	installable = $state(false);
	isStandalone = $state(detectStandalone());
	// iOS never fires beforeinstallprompt, so it needs manual "Add to Home Screen".
	readonly isIOS = detectIOS();
	dismissed = $state(false);

	constructor() {
		if (typeof window === 'undefined') return;
		this.dismissed = localStorage.getItem(DISMISS_KEY) === '1';

		window.addEventListener('beforeinstallprompt', (e) => {
			// Suppress Chrome's mini-infobar; we trigger install from our own UI.
			e.preventDefault();
			this.#deferred = e as BeforeInstallPromptEvent;
			this.installable = true;
		});
		window.addEventListener('appinstalled', () => {
			this.#deferred = null;
			this.installable = false;
			this.isStandalone = true;
		});
	}

	// Not installed, not dismissed, and either installable or on iOS.
	get showPrompt(): boolean {
		return !this.isStandalone && !this.dismissed && (this.installable || this.isIOS);
	}

	async promptInstall(): Promise<void> {
		if (!this.#deferred) return;
		await this.#deferred.prompt();
		const { outcome } = await this.#deferred.userChoice;
		this.#deferred = null;
		this.installable = false;
		if (outcome === 'accepted') this.isStandalone = true;
	}

	dismiss() {
		this.dismissed = true;
		if (typeof window !== 'undefined') localStorage.setItem(DISMISS_KEY, '1');
	}
}

export const pwa = new PwaState();
