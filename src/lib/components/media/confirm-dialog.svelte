<script lang="ts">
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';

	// A small controlled confirm dialog for actions that are awkward to undo (e.g. bulk
	// "mark season/series watched"). The parent binds `open` and handles `onconfirm`.
	let {
		open = $bindable(false),
		title,
		description,
		confirmLabel = 'Confirm',
		confirmVariant = 'default',
		busy = false,
		onconfirm
	}: {
		open?: boolean;
		title: string;
		description?: string;
		confirmLabel?: string;
		confirmVariant?: 'default' | 'destructive';
		busy?: boolean;
		onconfirm: () => void;
	} = $props();
</script>

<Dialog.Root bind:open>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>{title}</Dialog.Title>
			{#if description}
				<Dialog.Description>{description}</Dialog.Description>
			{/if}
		</Dialog.Header>
		<Dialog.Footer class="gap-2 sm:flex-col sm:gap-2">
			<Button variant={confirmVariant} onclick={onconfirm} disabled={busy}>{confirmLabel}</Button>
			<Dialog.Close class={buttonVariants({ variant: 'ghost' })}>Cancel</Dialog.Close>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
