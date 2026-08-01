<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { downloadExport } from '$lib/client/export';
	import { applyImport, parseFailureMessage, readImportFile } from '$lib/client/import';
	import type { ImportPlan } from '$lib/portability/plan';

	let busy = $state(false);
	let exportError = $state(false);
	// Set after a successful export so the user gets confirmation the file holds what they expect.
	let exported = $state<number | null>(null);

	let fileInput = $state<HTMLInputElement | null>(null);
	// A read-but-not-yet-applied file: import is a bulk write, so the user confirms what's in it first.
	let pending = $state<ImportPlan | null>(null);
	let importError = $state<string | null>(null);
	let imported = $state<number | null>(null);

	async function exportData() {
		busy = true;
		exportError = false;
		exported = null;
		try {
			exported = await downloadExport();
		} catch (err) {
			console.error('export: failed to build the export file', err);
			exportError = true;
		} finally {
			busy = false;
		}
	}

	async function chooseFile(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		// Reset immediately so re-picking the same file after a cancel still fires a change.
		input.value = '';
		if (!file) return;

		busy = true;
		importError = null;
		imported = null;
		pending = null;
		try {
			const result = await readImportFile(file);
			if (result.ok) pending = result.plan;
			else importError = parseFailureMessage(result.reason);
		} catch (err) {
			console.error('import: failed to read the export file', err);
			importError = "We couldn't read that file. Please try again.";
		} finally {
			busy = false;
		}
	}

	async function confirmImport() {
		if (!pending) return;
		busy = true;
		importError = null;
		try {
			const count = pending.counts.titles;
			await applyImport(pending);
			pending = null;
			imported = count;
		} catch (err) {
			console.error('import: failed to apply the export file', err);
			importError = "We couldn't finish the import. Please try again.";
		} finally {
			busy = false;
		}
	}

	function plural(count: number, noun: string): string {
		return `${count} ${noun}${count === 1 ? '' : 's'}`;
	}
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Your data</Card.Title>
		<Card.Description>
			Download everything you track — your titles, ratings, favourites, episode progress and the
			dates you watched them — as a JSON file that's yours to keep, and bring it back whenever you
			need it.
		</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-3">
		<p class="text-sm text-muted-foreground">
			Both work offline: the file is built from the copy stored on this device, and an import is
			saved locally straight away, then synced when you're back online. Artwork isn't included — it
			re-downloads on its own.
		</p>

		<div class="flex flex-wrap gap-2">
			<Button variant="outline" onclick={exportData} disabled={busy}>
				{busy ? 'Working…' : 'Export my data'}
			</Button>
			<Button variant="outline" onclick={() => fileInput?.click()} disabled={busy}>
				Import from a file
			</Button>
			<input
				bind:this={fileInput}
				type="file"
				accept="application/json,.json"
				class="hidden"
				onchange={chooseFile}
			/>
		</div>

		{#if exported !== null}
			<p class="text-sm text-muted-foreground">Exported {plural(exported, 'title')}.</p>
		{/if}
		{#if exportError}
			<p class="text-sm text-destructive">Couldn't build the export file. Please try again.</p>
		{/if}

		{#if pending}
			<div class="flex flex-col gap-2 rounded-md bg-muted/50 p-3">
				<p class="text-sm">
					Found {plural(pending.counts.titles, 'title')} and
					{plural(pending.counts.episodes, 'watched episode')}.
					{#if pending.counts.skipped > 0}
						<span class="text-muted-foreground">
							{plural(pending.counts.skipped, 'entry')} couldn't be read and will be left out.</span
						>
					{/if}
				</p>
				<p class="text-sm text-muted-foreground">
					Importing adds to your library — nothing already here is removed. Anything you've changed
					since this file was made stays as it is.
				</p>
				<div class="flex gap-2">
					<Button variant="outline" onclick={confirmImport} disabled={busy}>
						{busy ? 'Importing…' : 'Import'}
					</Button>
					<Button variant="ghost" onclick={() => (pending = null)} disabled={busy}>Cancel</Button>
				</div>
			</div>
		{/if}
		{#if imported !== null}
			<p class="text-sm text-muted-foreground">
				Imported {plural(imported, 'title')}. They'll sync to your other devices shortly.
			</p>
		{/if}
		{#if importError}
			<p class="text-sm text-destructive">{importError}</p>
		{/if}
	</Card.Content>
</Card.Root>
