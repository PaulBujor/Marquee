<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as InputOTP from '#lib/components/ui/input-otp/index.js';
	import OfflineAction from '#lib/components/offline-action.svelte';
	import { sync } from '#lib/client/sync/engine.svelte.js';
	import { signOutOffline } from '#lib/client/logout.js';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import type { ActionData, PageData } from './$types';

	let {
		user,
		codeTtlMinutes,
		form
	}: { user: PageData['user']; codeTtlMinutes: number; form: ActionData } = $props();

	let submitting = $state(false);
	let loggingOut = $state(false);
	let code = $state('');
	let codeForm = $state<HTMLFormElement | null>(null);

	const step = $derived(form && 'step' in form ? form.step : null);
	const message = $derived(form && 'message' in form ? form.message : null);
	const codeError = $derived(form && 'codeError' in form ? form.codeError : null);
	const pendingEmail = $derived(form && 'newEmail' in form ? (form.newEmail ?? '') : '');
	// The request's `locals.user` is still the old snapshot, so trust the action's returned address until the reload lands.
	const currentEmail = $derived(step === 'done' ? pendingEmail : user.email);
	// Client-side mirror of the server's CODE_REGEX check (the server stays authoritative).
	const codeValid = $derived(/^\d{6}$/.test(code));
	const online = $derived(sync.online);
	const OFFLINE_EMAIL_MSG = 'You need an internet connection to change your email.';

	const track = () => {
		submitting = true;
		return async ({ update }: { update: () => Promise<void> }) => {
			await update();
			submitting = false;
		};
	};

	const trackCode = () => {
		submitting = true;
		return async ({
			result,
			update
		}: {
			result: { type: string };
			update: () => Promise<void>;
		}) => {
			await update();
			submitting = false;
			code = '';
			if (result.type === 'success') await invalidateAll();
		};
	};

	// Offline the action can't clear the httpOnly cookie, so cancel the submit and sign out locally; the real logout flushes on reconnect.
	const trackLogout = ({ cancel }: { cancel: () => void }) => {
		if (!online) {
			cancel();
			loggingOut = true;
			void signOutOffline(user.id);
			return;
		}
		loggingOut = true;
		return async ({ update }: { update: () => Promise<void> }) => {
			await update();
			loggingOut = false;
		};
	};
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Account</Card.Title>
		<Card.Description>Signed in as <strong>{currentEmail}</strong>.</Card.Description>
	</Card.Header>
	<Card.Content>
		{#if step === 'done'}
			<p class="text-sm text-muted-foreground">
				Your email is now <strong>{pendingEmail}</strong>.
			</p>
		{:else if step === 'code'}
			<form
				bind:this={codeForm}
				method="POST"
				action="?/verifyEmailChange"
				class="flex flex-col gap-4"
				use:enhance={trackCode}
			>
				<p class="text-sm text-muted-foreground">
					Enter the 6-digit code we emailed to <strong>{pendingEmail}</strong>. It expires in
					{codeTtlMinutes} minutes.
				</p>
				<input type="hidden" name="newEmail" value={pendingEmail} />
				<input type="hidden" name="code" value={code} />
				<InputOTP.Root
					maxlength={6}
					bind:value={code}
					autocomplete="one-time-code"
					inputmode="numeric"
					disabled={submitting || !online}
					onComplete={() => online && codeValid && codeForm?.requestSubmit()}
				>
					{#snippet children({ cells })}
						<InputOTP.Group>
							{#each cells as cell, i (i)}
								<InputOTP.Slot {cell} />
							{/each}
						</InputOTP.Group>
					{/snippet}
				</InputOTP.Root>
				{#if codeError}
					<p class="text-sm text-destructive">{codeError}</p>
				{/if}
				{#if !online}
					<p class="text-sm text-muted-foreground">{OFFLINE_EMAIL_MSG}</p>
				{/if}
				<Button type="submit" disabled={submitting || !codeValid || !online}>
					{submitting ? 'Confirming…' : 'Confirm new email'}
				</Button>
			</form>
		{:else}
			<form
				method="POST"
				action="?/requestEmailChange"
				class="flex flex-col gap-3"
				use:enhance={track}
			>
				<label class="text-sm font-medium" for="newEmail">Change email</label>
				<Input
					id="newEmail"
					type="email"
					name="newEmail"
					placeholder="new@example.com"
					autocomplete="email"
					required
					disabled={submitting || !online}
					value={pendingEmail}
				/>
				{#if message}
					<p class="text-sm text-destructive">{message}</p>
				{/if}
				{#if online}
					<Button type="submit" disabled={submitting} class="self-start">
						{submitting ? 'Sending…' : 'Send confirmation code'}
					</Button>
				{:else}
					<OfflineAction message={OFFLINE_EMAIL_MSG} class="self-start">
						Send confirmation code
					</OfflineAction>
					<!-- Inline note as well as the tooltip: touch (the PWA's primary surface) gives no hover. -->
					<p class="text-sm text-muted-foreground">{OFFLINE_EMAIL_MSG}</p>
				{/if}
			</form>
		{/if}
	</Card.Content>
	<Card.Footer class="flex-col items-start gap-2 border-t pt-4">
		{#if !online}
			<!-- Logging back in needs a magic link/code by email, which we can't send offline. -->
			<p class="text-sm text-muted-foreground">
				You're offline — you won't be able to log back in until you have an internet connection.
			</p>
		{/if}
		<form method="POST" action="/?/logout" use:enhance={trackLogout}>
			<Button
				type="submit"
				variant="ghost"
				disabled={loggingOut}
				class="px-0 text-destructive hover:text-destructive"
			>
				<LogOutIcon class="size-4" />
				{loggingOut ? 'Logging out…' : 'Log out'}
			</Button>
		</form>
	</Card.Footer>
</Card.Root>
