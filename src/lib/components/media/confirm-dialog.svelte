<script lang="ts">
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';

	// A small controlled confirm dialog for actions that are awkward to undo (e.g. bulk
	// "mark season/series watched"). The parent binds `open` and handles `onconfirm`.
	interface Props {
		open?: boolean;
		title: string;
		description?: string;
		confirmLabel?: string;
		confirmVariant?: 'default' | 'destructive';
		busy?: boolean;
		onconfirm: () => void;
	}
	let {
		open = $bindable(false),
		title,
		description,
		confirmLabel = 'Confirm',
		confirmVariant = 'default',
		busy = false,
		onconfirm
	}: Props = $props();
</script>

<Dialog.Root bind:open>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>{title}</Dialog.Title>
			{#if description}
				<Dialog.Description>{description}</Dialog.Description>
			{/if}
		</Dialog.Header>
		<!-- Cancel first in the DOM so the footer's `flex-col-reverse` (mobile) puts the primary
		action on top, and the `sm:flex-row sm:justify-end` (desktop) puts it rightmost. -->
		<Dialog.Footer>
			<Dialog.Close class={buttonVariants({ variant: 'ghost' })}>Cancel</Dialog.Close>
			<Button variant={confirmVariant} onclick={onconfirm} disabled={busy}>{confirmLabel}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
