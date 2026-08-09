<script lang="ts">
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { sync } from '$lib/client/sync/engine.svelte';
	import CloudOffIcon from '@lucide/svelte/icons/cloud-off';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

	// Sync status light. Dashboard-cluster-light model: nothing renders on the happy path
	// (online + idle). It only lights up for an exception worth knowing about — offline, an in-flight
	// sync, or a failure — and disappears the moment things settle. Offline takes priority (the whole
	// channel is paused); then a hard error; then a transient in-flight sync.
	const indicator = $derived.by(() => {
		if (!sync.online)
			return {
				icon: CloudOffIcon,
				label: 'Offline — your changes are saved on this device and will sync when you reconnect.',
				tone: 'text-muted-foreground',
				spin: false
			};
		if (sync.status === 'error')
			return {
				icon: TriangleAlertIcon,
				label: "Couldn't sync your latest changes — retrying automatically.",
				tone: 'text-destructive',
				spin: false
			};
		if (sync.status === 'syncing')
			return {
				icon: RefreshCwIcon,
				label: 'Syncing your changes…',
				tone: 'text-muted-foreground',
				spin: true
			};
		return null;
	});
</script>

{#if indicator}
	{@const Icon = indicator.icon}
	<!-- Hover/focus tooltip (touch is a known browser gap — expected to be handled natively in time).
	aria-label carries the state for screen readers regardless. -->
	<Tooltip.Provider delayDuration={200}>
		<Tooltip.Root>
			<Tooltip.Trigger
				aria-label={indicator.label}
				class="flex size-9 shrink-0 items-center justify-center rounded-full {indicator.tone}"
			>
				<Icon class="size-4 {indicator.spin ? 'animate-spin' : ''}" />
			</Tooltip.Trigger>
			<Tooltip.Content>{indicator.label}</Tooltip.Content>
		</Tooltip.Root>
	</Tooltip.Provider>
{/if}
