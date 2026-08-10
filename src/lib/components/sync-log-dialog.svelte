<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { sync } from '$lib/client/sync/engine.svelte';
	import { syncLog } from '$lib/client/sync/log.svelte';
	import { formatLogText, formatTime } from '$lib/client/sync/log';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import CheckIcon from '@lucide/svelte/icons/check';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	// Ticks while a cycle is in flight so a stall shows its own duration growing — the symptom this
	// panel exists to make visible.
	let now = $state(Date.now());
	$effect(() => {
		if (!open || sync.cycleStartedAt === null) return;
		const timer = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});
	const runningFor = $derived(
		sync.cycleStartedAt === null
			? null
			: Math.max(0, Math.round((now - sync.cycleStartedAt) / 1000))
	);

	const lastSync = $derived(
		sync.lastSyncAt === null ? 'never this session' : formatTime(sync.lastSyncAt)
	);

	let copied = $state(false);
	async function copyLog() {
		try {
			await navigator.clipboard.writeText(formatLogText($state.snapshot(syncLog.entries)));
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			/* clipboard blocked — the log is still on screen to read */
		}
	}

	const LEVEL_CLASS = {
		info: 'text-muted-foreground',
		warn: 'text-foreground',
		error: 'text-destructive'
	} as const;
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="flex max-h-[85svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
		<Dialog.Header class="border-b border-border p-4">
			<Dialog.Title class="text-base">Sync details</Dialog.Title>
			<Dialog.Description class="text-xs">
				{sync.online ? 'Online' : 'Offline'} · {sync.status}{runningFor === null
					? ''
					: ` for ${runningFor}s`} · last synced {lastSync}
			</Dialog.Description>
		</Dialog.Header>

		<div class="min-h-0 flex-1 overflow-y-auto p-4">
			{#if syncLog.entries.length === 0}
				<p class="py-6 text-center text-sm text-muted-foreground">
					Nothing logged yet this session.
				</p>
			{:else}
				<ul class="flex flex-col gap-1 font-mono text-[0.7rem] leading-relaxed">
					{#each syncLog.entries as entry (entry.at + entry.message)}
						<li class="flex gap-2">
							<span class="shrink-0 text-muted-foreground">{formatTime(entry.at)}</span>
							<span class="shrink-0 text-muted-foreground">[{entry.channel}]</span>
							<span class="min-w-0 break-words {LEVEL_CLASS[entry.level]}">{entry.message}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		<div class="flex items-center justify-between gap-2 border-t border-border p-3">
			<Button variant="ghost" size="sm" onclick={() => syncLog.clear()}>Clear</Button>
			<Button variant="outline" size="sm" onclick={copyLog}>
				{#if copied}<CheckIcon class="size-4" />Copied{:else}<CopyIcon class="size-4" />Copy{/if}
			</Button>
		</div>
	</Dialog.Content>
</Dialog.Root>
