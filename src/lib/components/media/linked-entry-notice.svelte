<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import ConfirmDialog from './confirm-dialog.svelte';
	import Link2OffIcon from '@lucide/svelte/icons/link-2-off';
	import { getMedia, getMediaLinksTo, recordEvent } from '$lib/client/idb';
	import { sync } from '$lib/client/sync/engine.svelte';
	import { guardedWrite } from '$lib/client/write-guard';

	/**
	 * Shows matched custom entries on a linked title, with an unlink action. The only way back to
	 * a matched entry — once linked it's off every list and out of search.
	 */
	interface Props {
		/** Our media id for the title being viewed. */
		mediaId: string;
	}
	let { mediaId }: Props = $props();

	/** The user's own entries matched to this title, with the titles they were authored under. */
	let matched = $state<{ id: string; title: string }[]>([]);
	let confirming = $state<{ id: string; title: string } | null>(null);
	let confirmOpen = $state(false);
	let busy = $state(false);

	let loadGen = 0;

	$effect(() => {
		void sync.revision;
		void mediaId;
		const gen = ++loadGen;
		load(gen);
	});

	async function load(gen: number) {
		const links = await getMediaLinksTo(mediaId).catch(() => []);
		if (gen !== loadGen) return;
		const rows = await Promise.all(
			links.map(async (l) => {
				const media = await getMedia(l.mediaId);
				return media ? { id: l.mediaId, title: media.title } : null;
			})
		);
		if (gen !== loadGen) return;
		matched = rows.filter((r): r is { id: string; title: string } => r !== null);
	}

	async function unlink() {
		const entry = confirming;
		if (!entry || busy) return;
		busy = true;
		const ok = await guardedWrite(() => recordEvent('media.unlinked', entry.id, {}), {
			source: 'custom-media:unlink',
			userMessage: "Couldn't unlink that entry"
		});
		busy = false;
		if (!ok) return;

		confirmOpen = false;
		confirming = null;
		sync.requestSync();
		const gen = ++loadGen;
		await load(gen);
		// Other views read the same link state — the search page most of all, where the entry
		// reappears the moment it stops pointing anywhere.
		await invalidateAll();
	}
</script>

{#each matched as entry (entry.id)}
	<div class="flex flex-col gap-2 rounded-md border border-dashed border-border p-3">
		<p class="text-sm text-muted-foreground">
			Matched from your own entry <span class="font-medium text-foreground">{entry.title}</span>.
		</p>
		<Button
			variant="ghost"
			size="sm"
			class="self-start"
			onclick={() => {
				confirming = entry;
				confirmOpen = true;
			}}
			disabled={busy}
		>
			<Link2OffIcon class="size-4" />
			Unlink
		</Button>
	</div>
{/each}

<ConfirmDialog
	bind:open={confirmOpen}
	title="Unlink this entry?"
	description="Your own entry becomes searchable again with its own history. What you've watched here stays — unlinking separates the two titles, it doesn't undo the merge, so remove this one separately if you don't want it."
	confirmLabel="Unlink"
	{busy}
	onconfirm={unlink}
/>
