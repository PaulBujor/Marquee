<script lang="ts">
	import { sync } from '$lib/client/sync/engine.svelte';
	import CloudOffIcon from '@lucide/svelte/icons/cloud-off';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

	// Sync status light (MRQ-95). Dashboard-cluster-light model: nothing renders on the happy path
	// (online + idle). It only lights up for an exception worth knowing about — offline, an in-flight
	// sync, or a failure — and disappears the moment things settle. Offline takes priority (the whole
	// channel is paused); then a hard error; then a transient in-flight sync.
	const indicator = $derived.by(() => {
		if (!sync.online)
			return {
				icon: CloudOffIcon,
				label: 'Offline — changes will sync when you reconnect',
				tone: 'text-muted-foreground',
				spin: false
			};
		if (sync.status === 'error')
			return {
				icon: TriangleAlertIcon,
				label: 'Sync failed — retrying',
				tone: 'text-destructive',
				spin: false
			};
		if (sync.status === 'syncing')
			return { icon: RefreshCwIcon, label: 'Syncing…', tone: 'text-muted-foreground', spin: true };
		return null;
	});
</script>

{#if indicator}
	{@const Icon = indicator.icon}
	<span
		class="flex size-9 shrink-0 items-center justify-center {indicator.tone}"
		role="status"
		aria-live="polite"
		title={indicator.label}
		aria-label={indicator.label}
	>
		<Icon class="size-4 {indicator.spin ? 'animate-spin' : ''}" />
	</span>
{/if}
