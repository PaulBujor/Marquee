<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card';
	import * as Dialog from '$lib/components/ui/dialog';
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
		<Dialog.Root bind:open={deleteOpen}>
			<Dialog.Trigger class={buttonVariants({ variant: 'destructive' })}>
				Delete account
			</Dialog.Trigger>
			<Dialog.Content>
				<Dialog.Header>
					<Dialog.Title>Delete your account?</Dialog.Title>
					<Dialog.Description>
						This permanently deletes your account. Type <strong>{userEmail}</strong> to confirm.
					</Dialog.Description>
				</Dialog.Header>
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
					<Dialog.Footer>
						<Button
							type="submit"
							variant="destructive"
							disabled={submitting || confirmEmail.trim().toLowerCase() !== userEmail}
						>
							{submitting ? 'Deleting…' : 'Delete account'}
						</Button>
					</Dialog.Footer>
				</form>
			</Dialog.Content>
		</Dialog.Root>
	</Card.Content>
</Card.Root>
