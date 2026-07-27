<script lang="ts">
	import { notifications } from '$lib/state/notifications.svelte.js';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import BellIcon from '@lucide/svelte/icons/bell';
	import XIcon from '@lucide/svelte/icons/x';
</script>

{#if notifications.contextualPrompt}
	<Card.Root
		class="fixed inset-x-4 bottom-4 z-40 mx-auto flex max-w-md flex-row items-center gap-3 px-4 py-3 shadow-lg sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2"
	>
		<BellIcon class="size-5 shrink-0 text-muted-foreground" />
		<span class="flex-1 text-sm">Get notified when new episodes and releases arrive.</span>
		<Button size="sm" onclick={() => notifications.enable()} disabled={notifications.busy}>
			{notifications.busy ? 'Enabling…' : 'Enable'}
		</Button>
		<Button
			variant="ghost"
			size="icon-sm"
			class="-mr-1 shrink-0"
			aria-label="Not now"
			onclick={() => notifications.dismissContextual()}
		>
			<XIcon class="size-4" />
		</Button>
	</Card.Root>
{/if}
