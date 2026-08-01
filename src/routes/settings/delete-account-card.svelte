<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import OfflineAction from '$lib/components/offline-action.svelte';
	import { sync } from '$lib/client/sync/engine.svelte';
	import { wipeLocalData } from '$lib/client/idb';
	import { notifications } from '$lib/state/notifications.svelte.js';
	import type { ActionResult } from '@sveltejs/kit';
	import type { ActionData } from './$types';

	let { userEmail, form }: { userEmail: string; form: ActionData } = $props();

	let submitting = $state(false);
	let deleteOpen = $state(false);
	let confirmEmail = $state('');

	// Deleting the account hits the server; offline, gate the trigger with an explanation.
	const online = $derived(sync.online);

	const deleteError = $derived(form && 'deleteError' in form ? form.deleteError : null);

	const trackDelete = () => {
		submitting = true;
		return async ({ result, update }: { result: ActionResult; update: () => Promise<void> }) => {
			// A redirect means the server deleted the account: wipe this device's local replica and
			// tear down its push subscription before the redirect navigates (the active user — and so
			// the database to delete — is still this account at this point).
			if (result.type === 'redirect') {
				await notifications.disable();
				await wipeLocalData();
			}
			await update();
			submitting = false;
		};
	};
</script>

<Card.Root class="ring-destructive/40">
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
			{#if online}
				<AlertDialog.Trigger class={buttonVariants({ variant: 'destructive' })}>
					Delete account
				</AlertDialog.Trigger>
			{:else}
				<OfflineAction
					variant="destructive"
					message="You can't delete your account without an internet connection."
				>
					Delete account
				</OfflineAction>
				<!-- Inline note as well as the tooltip: touch (the PWA's primary surface) gives no hover. -->
				<p class="mt-2 text-sm text-muted-foreground">
					You'll need an internet connection to delete your account.
				</p>
			{/if}
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
							disabled={submitting || !online || confirmEmail.trim().toLowerCase() !== userEmail}
						>
							{submitting ? 'Deleting…' : 'Delete account'}
						</Button>
					</AlertDialog.Footer>
				</form>
			</AlertDialog.Content>
		</AlertDialog.Root>
	</Card.Content>
</Card.Root>
