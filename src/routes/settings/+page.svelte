<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as InputOTP from '$lib/components/ui/input-otp';
	import * as ToggleGroup from '$lib/components/ui/toggle-group';
	import { theme } from '$lib/state/theme.svelte.js';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let submitting = $state(false);
	let code = $state('');
	let codeForm = $state<HTMLFormElement | null>(null);
	let deleteOpen = $state(false);
	let confirmEmail = $state('');

	const step = $derived(form && 'step' in form ? form.step : null);
	const message = $derived(form && 'message' in form ? form.message : null);
	const codeError = $derived(form && 'codeError' in form ? form.codeError : null);
	const deleteError = $derived(form && 'deleteError' in form ? form.deleteError : null);
	const pendingEmail = $derived(form && 'newEmail' in form ? (form.newEmail ?? '') : '');
	// After a successful change the request's `locals.user` is still the old snapshot,
	// so trust the action's returned address until the reload lands.
	const currentEmail = $derived(step === 'done' ? pendingEmail : data.user.email);
	// Client-side mirror of the server's CODE_RE check (the server stays authoritative).
	const codeValid = $derived(/^\d{6}$/.test(code));

	const themeModes = [
		{ value: 'auto', label: 'Auto' },
		{ value: 'light', label: 'Light' },
		{ value: 'dark', label: 'Dark' }
	] as const;

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
			// On success the account email changed; refetch so the header/page reflect it.
			if (result.type === 'success') await invalidateAll();
		};
	};

	const trackDelete = () => {
		submitting = true;
		return async ({ update }: { update: () => Promise<void> }) => {
			await update();
			submitting = false;
		};
	};
</script>

<svelte:head>
	<title>Settings · Marquee</title>
</svelte:head>

<main class="mx-auto flex w-full max-w-lg flex-col gap-6 p-6">
	<h1 class="font-serif text-2xl font-semibold">Settings</h1>

	<!-- Account -->
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
						{data.codeTtlMinutes} minutes.
					</p>
					<input type="hidden" name="newEmail" value={pendingEmail} />
					<input type="hidden" name="code" value={code} />
					<InputOTP.Root
						maxlength={6}
						bind:value={code}
						autocomplete="one-time-code"
						inputmode="numeric"
						disabled={submitting}
						onComplete={() => codeValid && codeForm?.requestSubmit()}
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
					<Button type="submit" disabled={submitting || !codeValid}>
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
						value={pendingEmail}
					/>
					{#if message}
						<p class="text-sm text-destructive">{message}</p>
					{/if}
					<Button type="submit" disabled={submitting} class="self-start">
						{submitting ? 'Sending…' : 'Send confirmation code'}
					</Button>
				</form>
			{/if}
		</Card.Content>
		<Card.Footer class="border-t pt-4">
			<!-- Sign out submits the existing root `?/logout` action (redirects to /login). -->
			<form method="POST" action="/?/logout" use:enhance>
				<Button type="submit" variant="ghost" class="px-0 text-destructive hover:text-destructive">
					<LogOutIcon class="size-4" />
					Log out
				</Button>
			</form>
		</Card.Footer>
	</Card.Root>

	<!-- Appearance -->
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
						class="flex-1 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground {i ===
						0
							? 'rounded-l-lg!'
							: ''} {i === themeModes.length - 1 ? 'rounded-r-lg!' : ''}"
					>
						{m.label}
					</ToggleGroup.Item>
				{/each}
			</ToggleGroup.Root>
		</Card.Content>
	</Card.Root>

	<!-- Danger zone -->
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
							This permanently deletes your account. Type <strong>{data.user.email}</strong> to confirm.
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
							placeholder={data.user.email}
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
								disabled={submitting || confirmEmail.trim().toLowerCase() !== data.user.email}
							>
								{submitting ? 'Deleting…' : 'Delete account'}
							</Button>
						</Dialog.Footer>
					</form>
				</Dialog.Content>
			</Dialog.Root>
		</Card.Content>
	</Card.Root>
</main>
