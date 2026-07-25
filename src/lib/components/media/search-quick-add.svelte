<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import type { TrackingStatus } from '$lib/sync/events';
	import CheckIcon from '@lucide/svelte/icons/check';
	import PlusIcon from '@lucide/svelte/icons/plus';

	// Quick add/remove button for a search row (MRQ-125). Presentational: the parent owns the
	// tracked lookup + write handlers so a change on one row reflects on all of them.
	interface Props {
		title: string;
		/** Current tracking status, or undefined when the title isn't on any list. */
		status: TrackingStatus | undefined;
		busy: boolean;
		onadd: () => void;
		onremove: () => void;
	}
	let { title, status, busy, onadd, onremove }: Props = $props();

	const tracked = $derived(status !== undefined);
	// One-tap remove only for a plain "want to watch". Titles further along (watching / completed /
	// didn't finish) keep a static tick and are managed from the detail page, so a stray tap here
	// can't silently wipe episode-watch history.
	const removable = $derived(status === 'want_to_watch');
</script>

{#if !tracked}
	<Button
		variant="outline"
		size="icon"
		shape="round"
		class="shrink-0 text-muted-foreground"
		onclick={onadd}
		disabled={busy}
		aria-label={`Add ${title} to want to watch`}
		title="Add to want to watch"
	>
		<PlusIcon class="size-4" />
	</Button>
{:else if removable}
	<Button
		variant="outline"
		size="icon"
		shape="round"
		class="shrink-0 border-primary text-primary"
		onclick={onremove}
		disabled={busy}
		aria-pressed="true"
		aria-label={`Remove ${title} from your list`}
		title="On your list — tap to remove"
	>
		<CheckIcon class="size-4" />
	</Button>
{:else}
	<span
		class="flex size-9 shrink-0 items-center justify-center rounded-full text-primary"
		title="On your list"
		aria-label={`${title} is on your list`}
	>
		<CheckIcon class="size-4" />
	</span>
{/if}
