<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import * as ToggleGroup from '$lib/components/ui/toggle-group';
	import { theme } from '$lib/state/theme.svelte.js';

	const themeModes = [
		{ value: 'auto', label: 'Auto' },
		{ value: 'light', label: 'Light' },
		{ value: 'dark', label: 'Dark' }
	] as const;
</script>

<Card.Root data-spec-ref="settings-appearance-section">
	<Card.Header>
		<Card.Title>Appearance</Card.Title>
		<Card.Description>Choose how Marquee looks. Auto follows your system.</Card.Description>
	</Card.Header>
	<Card.Content>
		<ToggleGroup.Root
			type="single"
			variant="outline"
			value={theme.mode}
			onValueChange={(v) => v && theme.set(v as 'auto' | 'light' | 'dark')}
			class="w-full"
		>
			{#each themeModes as m, i (m.value)}
				<ToggleGroup.Item
					value={m.value}
					class="flex-1 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground {i === 0
						? 'rounded-l-full!'
						: ''} {i === themeModes.length - 1 ? 'rounded-r-full!' : ''}"
				>
					{m.label}
				</ToggleGroup.Item>
			{/each}
		</ToggleGroup.Root>
	</Card.Content>
</Card.Root>
