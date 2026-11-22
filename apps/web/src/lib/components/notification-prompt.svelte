<script lang="ts">
	import { notifications } from '#lib/state/notifications.svelte.js';
	import { promptToast } from '#lib/state/prompt-toast.svelte.js';

	// `enable()` clears contextualPrompt, so the toast auto-dismisses — no busy label needed.
	promptToast({
		id: 'notify-optin',
		when: () => notifications.contextualPrompt,
		message: () => 'Get notified when new episodes and releases arrive.',
		action: () => ({ label: 'Enable', onClick: () => notifications.enable() }),
		onDismiss: () => notifications.dismissContextual()
	});
</script>
