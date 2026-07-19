<script lang="ts">
	import { pwa } from '$lib/state/pwa.svelte.js';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import XIcon from '@lucide/svelte/icons/x';
</script>

{#if pwa.showPrompt}
	<Card.Root
		class="fixed inset-x-4 bottom-4 z-40 mx-auto flex max-w-md flex-row items-center gap-3 px-4 py-3 shadow-lg sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2"
	>
		{#if pwa.installable}
			<span class="flex-1 text-sm">Install Marquee for a faster, full-screen experience.</span>
			<Button size="sm" onclick={() => pwa.promptInstall()}>Install</Button>
		{:else if pwa.isIOS}
			<span class="flex-1 text-sm">
				Install Marquee: tap the Share icon, then <strong>Add to Home Screen</strong>.
			</span>
		{/if}
		<Button
			variant="ghost"
			size="icon-sm"
			class="-mr-1 shrink-0"
			aria-label="Dismiss"
			onclick={() => pwa.dismiss()}
		>
			<XIcon class="size-4" />
		</Button>
	</Card.Root>
{/if}
