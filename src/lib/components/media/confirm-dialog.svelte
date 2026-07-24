<script lang="ts">
	import * as AlertDialog from '$lib/components/ui/alert-dialog';

	// A small controlled confirmation for actions that are awkward to undo (e.g. bulk "mark
	// season/series watched"). An **alert** dialog (not a plain dialog): it takes role=alertdialog,
	// traps focus, and doesn't dismiss on outside-click/Escape — the user must choose. The parent
	// binds `open`; `onconfirm` fires on the action (the dialog auto-closes).
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

<AlertDialog.Root bind:open>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{title}</AlertDialog.Title>
			{#if description}
				<AlertDialog.Description>{description}</AlertDialog.Description>
			{/if}
		</AlertDialog.Header>
		<!-- Cancel first in the DOM so the footer's flex-col-reverse (mobile) puts the primary
		action on top, and sm:flex-row justify-end (desktop) puts it rightmost. -->
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action variant={confirmVariant} onclick={onconfirm} disabled={busy}>
				{confirmLabel}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
