<script lang="ts">
	import { toast } from 'svelte-sonner';
	import ErrorLogDialog from './error-log-dialog.svelte';
	import { errorLog } from '#lib/client/errors.svelte.js';
	import { admitToast } from '#lib/client/errors.js';

	let dialogOpen = $state(false);
	let recentToasts: number[] = [];

	$effect(() => {
		const entry = errorLog.pending;
		if (!entry) return;
		// Clear first: raising the toast must not be able to re-enter this effect.
		errorLog.pending = null;
		const admitted = admitToast(recentToasts, Date.now());
		recentToasts = admitted.recent;
		if (!admitted.show) {
			errorLog.suppressedCount++;
			return;
		}

		toast.error('Something went wrong', {
			description: entry.message,
			duration: 8000,
			action: { label: 'See error', onClick: () => (dialogOpen = true) }
		});
	});
</script>

<ErrorLogDialog bind:open={dialogOpen} />
