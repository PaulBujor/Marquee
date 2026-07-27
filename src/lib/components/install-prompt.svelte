<script lang="ts">
	import { pwa } from '$lib/state/pwa.svelte.js';
	import { promptToast } from '$lib/state/prompt-toast.svelte.js';

	promptToast({
		id: 'pwa-install',
		when: () => pwa.showPrompt,
		message: () =>
			pwa.installable
				? 'Install Marquee for a faster, full-screen experience.'
				: 'Install Marquee: tap the Share icon, then Add to Home Screen.',
		// iOS has no install API — the toast is instructional only, no action button.
		action: () =>
			pwa.installable ? { label: 'Install', onClick: () => pwa.promptInstall() } : undefined,
		onDismiss: () => pwa.dismiss()
	});
</script>
