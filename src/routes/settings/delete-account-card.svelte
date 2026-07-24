<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import type { ActionData } from './$types';

	let { userEmail, form }: { userEmail: string; form: ActionData } = $props();

	let submitting = $state(false);
	let deleteOpen = $state(false);
	let confirmEmail = $state('');

	const deleteError = $derived(form && 'deleteError' in form ? form.deleteError : null);

	const trackDelete = () => {
		submitting = true;
		return async ({ update }: { update: () => Promise<void> }) => {
			await update();
			submitting = false;
		};
	};
</script>

<Card.Root class="border-destructive/50">
	<Card.Header>
		<Card.Title>Delete account</Card.Title>
		<Card.Description>
			Permanently delete your account and all associated data. This cannot be undone.
		</Card.Description>
	</Card.Header>
	<Card.Content>
		<!-- AlertDialog (not Dialog): deleting the account is the most destructive, can't-be-undone
		action, so no outside-click/Escape dismiss. The delete control stays a plain submit button
		inside the form (not AlertDialog.Action, which auto-closes) so a server validation error
		keeps the dialog open. -->
		<AlertDialog.Root bind:open={deleteOpen}>
			<AlertDialog.Trigger class={buttonVariants({ variant: 'destructive' })}>
				Delete account
			</AlertDialog.Trigger>
			<AlertDialog.Content>
				<AlertDialog.Header>
					<AlertDialog.Title>Delete your account?</AlertDialog.Title>
					<AlertDialog.Description>
						This permanently deletes your account. Type <strong>{userEmail}</strong> to confirm.
					</AlertDialog.Description>
				</AlertDialog.Header>
				<form
					method="POST"
					action="?/deleteAccount"
					class="flex flex-col gap-3"
					use:enhance={trackDelete}
				>
					<Input
						type="email"
						name="confirmEmail"
						bind:value={confirmEmail}
						placeholder={userEmail}
						autocomplete="off"
						aria-label="Confirm your email address"
						required
					/>
					{#if deleteError}
						<p class="text-sm text-destructive">{deleteError}</p>
					{/if}
					<AlertDialog.Footer>
						<AlertDialog.Cancel type="button" disabled={submitting}>Cancel</AlertDialog.Cancel>
						<Button
							type="submit"
							variant="destructive"
							disabled={submitting || confirmEmail.trim().toLowerCase() !== userEmail}
						>
							{submitting ? 'Deleting…' : 'Delete account'}
						</Button>
					</AlertDialog.Footer>
				</form>
			</AlertDialog.Content>
		</AlertDialog.Root>
	</Card.Content>
</Card.Root>
