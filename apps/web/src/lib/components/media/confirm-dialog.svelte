<script lang="ts">
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';

	// An **alert** dialog: traps focus and won't dismiss on outside-click/Escape — the user must choose.
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
		<!-- Cancel first in the DOM so the footer's flex-col-reverse puts the primary action on top on mobile. -->
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action variant={confirmVariant} onclick={onconfirm} disabled={busy}>
				{confirmLabel}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
