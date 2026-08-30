<script lang="ts">
	import * as Tooltip from '$lib/components/ui/tooltip';
	import SyncLogDialog from '$lib/components/sync-log-dialog.svelte';
	import { goto } from '$app/navigation';
	import { sync } from '$lib/client/sync/engine.svelte';
	import { syncLog } from '$lib/client/sync/log.svelte';
	import CloudOffIcon from '@lucide/svelte/icons/cloud-off';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

	// Sync status light. Dashboard-cluster-light model: nothing is *drawn* on the happy path
	// (online + idle). It only lights up for an exception worth knowing about — offline, a session
	// expiry, an in-flight sync, or a failure. Offline takes priority (being offline means you can't
	// sign in either); then signed-out; then a hard error; then a transient in-flight sync.
	const indicator = $derived.by(() => {
		if (!sync.online)
			return {
				icon: CloudOffIcon,
				label: 'Offline — your changes are saved on this device and will sync when you reconnect.',
				tone: 'text-muted-foreground',
				spin: false
			};
		if (sync.status === 'signed-out')
			return {
				icon: LogOutIcon,
				label: "You're signed out — your changes are saved on this device and will sync when you sign in again.",
				tone: 'text-destructive',
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

<!-- Always rendered, empty when idle: the hidden double-tap has to work in every sync state.
`touch-manipulation` keeps it from zooming the page. In the signed-out state, the double-tap sync-log
gesture is dropped to avoid a collision: a double-tap would both navigate and open the log behind it. -->
<Tooltip.Provider delayDuration={200}>
	<Tooltip.Root>
		<Tooltip.Trigger
			aria-label={indicator?.label ?? 'Sync details'}
			onclick={() => {
				// Single tap → navigate to /login when signed out.
				if (sync.status === 'signed-out') goto('/login');
			}}
			ondblclick={() => {
				// Double-tap opens the sync log — but not in the signed-out state (single-tap navigates).
				if (sync.status !== 'signed-out') logOpen = true;
			}}
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
