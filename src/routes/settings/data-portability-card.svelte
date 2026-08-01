<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { downloadExport } from '$lib/client/export';

	let busy = $state(false);
	let errored = $state(false);
	// Set after a successful export so the user gets confirmation the file holds what they expect.
	let exported = $state<number | null>(null);

	async function exportData() {
		busy = true;
		errored = false;
		exported = null;
		try {
			exported = await downloadExport();
		} catch (err) {
			console.error('export: failed to build the export file', err);
			errored = true;
		} finally {
			busy = false;
		}
	}
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Your data</Card.Title>
		<Card.Description>
			Download everything you track — your titles, ratings, favourites, episode progress and the
			dates you watched them — as a JSON file that's yours to keep.
		</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-3">
		<p class="text-sm text-muted-foreground">
			The file is built from the copy stored on this device, so it works offline and includes
			changes that haven't synced yet. Artwork isn't included — it re-downloads on its own.
		</p>
		<Button variant="outline" class="self-start" onclick={exportData} disabled={busy}>
			{busy ? 'Preparing…' : 'Export my data'}
		</Button>
		{#if exported !== null}
			<p class="text-sm text-muted-foreground">
				Exported {exported}
				{exported === 1 ? 'title' : 'titles'}.
			</p>
		{/if}
		{#if errored}
			<p class="text-sm text-destructive">Couldn't build the export file. Please try again.</p>
		{/if}
	</Card.Content>
</Card.Root>
