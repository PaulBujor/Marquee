<script lang="ts">
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { wipeLocalData } from '$lib/client/idb';
	import { runSync } from '$lib/client/sync/sync';
	import { sync } from '$lib/client/sync/engine.svelte';
	import { estimateStorage } from '$lib/client/storage';

	let open = $state(false);
	let busy = $state(false);
	let errored = $state(false);

	// Rough on-device usage, shown so the user can see the offline copy's footprint.
	let usage = $state<string | null>(null);
	$effect(() => {
		estimateStorage().then((e) => {
			if (e && e.usage > 0) usage = formatBytes(e.usage);
		});
	});

	// "Last synced" is shown at all times so it's clear how current the offline copy is — and how much
	// a "clear local data" would discard when there are unsynced offline changes.
	const online = $derived(sync.online);
	const lastSyncAt = $derived(sync.lastSyncAt);
	const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short'
	});
	const lastSyncedLabel = $derived(
		lastSyncAt ? dateTimeFmt.format(new Date(lastSyncAt)) : 'not yet synced'
	);

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		const units = ['KB', 'MB', 'GB'];
		let value = bytes / 1024;
		let unit = 0;
		while (value >= 1024 && unit < units.length - 1) {
			value /= 1024;
			unit++;
		}
		return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
	}

	async function clearLocalData() {
		busy = true;
		errored = false;
		try {
			// Flush pending local events first so a wipe doesn't drop unsynced edits (best-effort —
			// offline, there's nothing to push and we proceed anyway).
			await runSync().catch((err) => console.warn('clear local data: pre-wipe flush failed', err));
			sync.stop();
			await wipeLocalData();
			location.reload(); // re-init on a fresh store → re-pull everything from the server
		} catch (err) {
			console.error('clear local data: wipe failed', err);
			errored = true;
			busy = false; // leave the dialog open so the user can retry
		}
	}
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Data &amp; cache</Card.Title>
		<Card.Description>
			Clear Marquee's offline copy on this device and re-download it from the server. Useful if
			something looks out of date.
		</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-3">
		<p class="text-sm text-muted-foreground">
			Last synced {lastSyncedLabel}{usage ? ` · using about ${usage}` : ''}.
			{#if !online}<span class="text-foreground">
					You're offline — changes will sync when you reconnect.</span
				>{/if}
		</p>
		<AlertDialog.Root bind:open>
			<AlertDialog.Trigger class={buttonVariants({ variant: 'outline' })}>
				Clear local data
			</AlertDialog.Trigger>
			<AlertDialog.Content>
				<AlertDialog.Header>
					<AlertDialog.Title>Clear local data on this device?</AlertDialog.Title>
					<AlertDialog.Description>
						This removes the offline copy stored on this device and re-syncs everything from the
						server. Your tracked titles and progress are safe — they're kept on the server too.
						<strong class="text-foreground">
							Any changes made since the last sync ({lastSyncedLabel}) that haven't reached the
							server yet will be permanently discarded.</strong
						>
					</AlertDialog.Description>
				</AlertDialog.Header>
				{#if !online}
					<p class="text-sm text-destructive">
						You're offline, so unsynced changes can't be saved first — they'll be lost.
					</p>
				{/if}
				{#if errored}
					<p class="text-sm text-destructive">Couldn't clear local data. Please try again.</p>
				{/if}
				<AlertDialog.Footer>
					<AlertDialog.Cancel type="button" disabled={busy}>Cancel</AlertDialog.Cancel>
					<!-- Plain button (not AlertDialog.Action) so the dialog stays open while we flush + wipe. -->
					<Button variant="outline" onclick={clearLocalData} disabled={busy}>
						{busy ? 'Clearing…' : 'Clear & re-sync'}
					</Button>
				</AlertDialog.Footer>
			</AlertDialog.Content>
		</AlertDialog.Root>
	</Card.Content>
</Card.Root>
