<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { errorLog } from '$lib/client/errors.svelte';
	import { formatErrorText, formatTime } from '$lib/client/errors';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import CheckIcon from '@lucide/svelte/icons/check';

	/**
	 * What actually went wrong, in full — the thing behind the toast's "See error". Deliberately
	 * shows the raw message and stack rather than a friendly summary: by the time someone opens this
	 * they've already read the friendly version and want something they can paste into a bug report.
	 */
	let { open = $bindable(false) }: { open?: boolean } = $props();

	let copied = $state(false);
	async function copyLog() {
		try {
			await navigator.clipboard.writeText(formatErrorText($state.snapshot(errorLog.entries)));
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			/* clipboard blocked — the log is still on screen to read */
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="flex max-h-[85svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
		<Dialog.Header class="border-b border-border p-4">
			<Dialog.Title class="text-base">Errors</Dialog.Title>
			<Dialog.Description class="text-xs">
				Recorded on this device, this session. Sent to the server log too — copying this into a bug
				report is the fastest way to get it fixed.
			</Dialog.Description>
		</Dialog.Header>

		<div class="min-h-0 flex-1 overflow-y-auto p-4">
			{#if errorLog.entries.length === 0}
				<p class="text-sm text-muted-foreground">Nothing has gone wrong this session.</p>
			{:else}
				<ul class="flex flex-col gap-3">
					{#each errorLog.entries as entry (entry.at + entry.message)}
						<li class="flex flex-col gap-1 border-b border-border pb-3 last:border-b-0 last:pb-0">
							<div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
								<span class="font-mono text-muted-foreground">{formatTime(entry.at)}</span>
								{#if entry.source}
									<span class="font-medium text-muted-foreground">{entry.source}</span>
								{/if}
								{#if entry.count > 1}
									<span class="text-muted-foreground">×{entry.count}</span>
								{/if}
								{#if entry.status !== undefined}
									<span class="text-muted-foreground">HTTP {entry.status}</span>
								{/if}
							</div>
							<p class="text-sm break-words text-destructive">{entry.message}</p>
							{#if entry.stack}
								<pre
									class="max-h-32 overflow-auto rounded-sm bg-muted p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">{entry.stack}</pre>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		<div class="flex justify-end gap-2 border-t border-border p-4">
			{#if errorLog.entries.length > 0}
				<Button variant="ghost" onclick={() => errorLog.clear()}>Clear</Button>
				<Button variant="outline" onclick={copyLog}>
					{#if copied}
						<CheckIcon class="size-4" />
						Copied
					{:else}
						<CopyIcon class="size-4" />
						Copy
					{/if}
				</Button>
			{/if}
			<Button onclick={() => (open = false)}>Close</Button>
		</div>
	</Dialog.Content>
</Dialog.Root>
