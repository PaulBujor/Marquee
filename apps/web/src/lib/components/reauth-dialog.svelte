<script lang="ts">
	import { enhance } from '$app/forms';
	import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as InputOTP from '#lib/components/ui/input-otp/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';

	/**
	 * Re-proves the person at the keyboard without a full sign-out. Reuses the sign-in ceremony
	 * (passkey, or an emailed 6-digit code) and reports success so the caller can retry the action
	 * that hit the recent-sign-in gate.
	 */
	let {
		open = $bindable(false),
		email,
		redirectTo,
		onSuccess
	}: {
		open: boolean;
		email: string;
		redirectTo: string;
		onSuccess: () => void;
	} = $props();

	let step = $state<'passkey' | 'email' | 'code'>('passkey');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let code = $state('');
	let codeForm = $state<HTMLFormElement | null>(null);
	let supported = $state(false);

	// A reopened dialog must not inherit the previous attempt's step, code or error.
	$effect(() => {
		if (!open) return;
		supported = browserSupportsWebAuthn();
		step = 'passkey';
		error = null;
		code = '';
		busy = false;
	});

	const codeValid = $derived(/^\d{6}$/.test(code));

	async function withPasskey() {
		busy = true;
		error = null;
		try {
			const optionsRes = await fetch('/api/passkey/login/options', { method: 'POST' });
			if (!optionsRes.ok) throw new Error(String(optionsRes.status));
			const authentication = await startAuthentication({
				optionsJSON: await optionsRes.json(),
				useBrowserAutofill: false
			});
			const verifyRes = await fetch('/api/passkey/login/verify', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ response: authentication, redirectTo })
			});
			if (!verifyRes.ok) throw new Error(String(verifyRes.status));
			onSuccess();
		} catch {
			error = "That passkey didn't work. Try again or use your email.";
		} finally {
			busy = false;
		}
	}

	// The sign-in actions are on /login, so they stay absolute: `?/request` would target the page
	// hosting the dialog. `mode=standalone` asks for a code, which a dialog can actually use.
	const trackRequest = () => {
		busy = true;
		return async ({ result }: { result: { type: string } }) => {
			busy = false;
			if (result.type === 'success') {
				step = 'code';
				return;
			}
			error = "We couldn't send a code. Try again.";
		};
	};

	const trackCode = () => {
		busy = true;
		return async ({ result }: { result: { type: string } }) => {
			busy = false;
			if (result.type === 'success') {
				onSuccess();
				return;
			}
			code = '';
			error = 'That code did not work. Try again.';
		};
	};
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Sign in again</Dialog.Title>
			<Dialog.Description>
				This change needs a recent sign-in. Confirm it's you — you stay signed in on this device.
			</Dialog.Description>
		</Dialog.Header>

		{#if step === 'passkey'}
			{#if supported}
				<Button class="w-full" disabled={busy} onclick={withPasskey}>
					<KeyRoundIcon class="size-4" />
					{busy ? 'Waiting for your passkey…' : 'Use your passkey'}
				</Button>
			{/if}
			<Button variant="ghost" class="w-full" disabled={busy} onclick={() => (step = 'email')}>
				Email me a code instead
			</Button>
		{:else if step === 'email'}
			<form
				method="POST"
				action="/login?/request"
				class="flex flex-col gap-3"
				use:enhance={trackRequest}
			>
				<input type="hidden" name="email" value={email} />
				<input type="hidden" name="mode" value="standalone" />
				<input type="hidden" name="redirectTo" value={redirectTo} />
				<p class="text-sm text-muted-foreground">
					We'll email a 6-digit code to <strong>{email}</strong>.
				</p>
				<Button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send me a code'}</Button>
			</form>
		{:else}
			<form
				bind:this={codeForm}
				method="POST"
				action="/login?/reauth"
				class="flex flex-col gap-3"
				use:enhance={trackCode}
			>
				<input type="hidden" name="code" value={code} />
				<p class="text-sm text-muted-foreground">
					Enter the 6-digit code we emailed to <strong>{email}</strong>.
				</p>
				<InputOTP.Root
					maxlength={6}
					bind:value={code}
					autocomplete="one-time-code"
					inputmode="numeric"
					disabled={busy}
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
				<Button type="submit" disabled={busy || !codeValid}>
					{busy ? 'Confirming…' : 'Confirm it’s me'}
				</Button>
			</form>
		{/if}

		{#if error}
			<p class="text-sm text-destructive">{error}</p>
		{/if}

		<Dialog.Footer>
			<Dialog.Close type="button" disabled={busy}>Cancel</Dialog.Close>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
