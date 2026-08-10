<script lang="ts">
	import * as Tooltip from '$lib/components/ui/tooltip';
	import SyncLogDialog from '$lib/components/sync-log-dialog.svelte';
	import { sync } from '$lib/client/sync/engine.svelte';
	import { syncLog } from '$lib/client/sync/log.svelte';
	import CloudOffIcon from '@lucide/svelte/icons/cloud-off';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

	// Sync status light. Dashboard-cluster-light model: nothing is *drawn* on the happy path
	// (online + idle). It only lights up for an exception worth knowing about — offline, an in-flight
	// sync, or a failure. Offline takes priority (the whole channel is paused); then a hard error;
	// then a transient in-flight sync.
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

	syncLog.load();

	let logOpen = $state(false);
</script>

<!-- The button is always rendered, even with no icon in it: the hidden double-tap has to work in
every sync state, including the idle one where nothing is drawn. Sized to match the logo beside it
so lighting up never changes the header's height. `touch-manipulation` keeps a double-tap from
zooming the page. -->
<Tooltip.Provider delayDuration={200}>
	<Tooltip.Root>
		<Tooltip.Trigger
			aria-label={indicator?.label ?? 'Sync details'}
			ondblclick={() => (logOpen = true)}
			class="flex size-6 shrink-0 touch-manipulation items-center justify-center rounded-full {indicator?.tone ??
				''}"
		>
			{#if indicator}
				{@const Icon = indicator.icon}
				<Icon class="size-4 {indicator.spin ? 'animate-spin' : ''}" />
			{/if}
		</Tooltip.Trigger>
		{#if indicator}
			<Tooltip.Content>{indicator.label}</Tooltip.Content>
		{/if}
	</Tooltip.Root>
</Tooltip.Provider>

<SyncLogDialog bind:open={logOpen} />
