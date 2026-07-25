<script lang="ts">
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { wipeLocalData } from '$lib/client/idb';
	import { runSync } from '$lib/client/sync/sync';
	import { sync } from '$lib/client/sync/engine.svelte';

	let open = $state(false);
	let busy = $state(false);
	let errored = $state(false);

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
	<Card.Content>
		<AlertDialog.Root bind:open>
			<AlertDialog.Trigger class={buttonVariants({ variant: 'outline' })}>
				Clear local data
			</AlertDialog.Trigger>
			<AlertDialog.Content>
				<AlertDialog.Header>
					<AlertDialog.Title>Clear local data on this device?</AlertDialog.Title>
					<AlertDialog.Description>
						This removes the offline copy stored on this device and re-syncs everything from the
						server. Your tracked titles and progress are safe — they're kept on the server too. Any
						changes made offline that haven't synced yet will be lost.
					</AlertDialog.Description>
				</AlertDialog.Header>
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
