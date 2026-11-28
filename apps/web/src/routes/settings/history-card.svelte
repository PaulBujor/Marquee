<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { Button, buttonVariants } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { haptics } from '#lib/client/history/haptics.svelte.js';

	// `navigator.vibrate` is absent on iOS and unreliable on desktop, so the toggle only appears
	// where it does something — read after mount so SSR and hydration agree.
	let canTick = $state(false);
	onMount(() => (canTick = haptics.supported));
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Time travel</Card.Title>
		<Card.Description>
			Scrub back through the log event by event and put the library back the way it was — a rewind,
			not a reset.
		</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-wrap items-center gap-2">
		<a href={resolve('/history')} class={buttonVariants({ variant: 'outline' })}
			>Rewind the library</a
		>
		{#if canTick}
			<Button
				variant="outline"
				size="sm"
				aria-pressed={haptics.enabled}
				onclick={() => haptics.set(!haptics.enabled)}
			>
				Ticks {haptics.enabled ? 'on' : 'off'}
			</Button>
		{/if}
	</Card.Content>
</Card.Root>
