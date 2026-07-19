<script lang="ts">
	import { enhance } from '$app/forms';
	import { browser } from '$app/environment';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card';
	import * as InputOTP from '$lib/components/ui/input-otp';
	import { focusFirstInput } from '$lib/utils.js';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let submitting = $state(false);
	let code = $state('');
	let codeForm = $state<HTMLFormElement | null>(null);
	let emailInput = $state<HTMLInputElement | null>(null);
	let otpRoot = $state<HTMLElement | null>(null);

	// Autofocus whichever field is on screen: email on the sign-in step, the code on the code step.
	$effect(() => focusFirstInput(emailInput));
	$effect(() => focusFirstInput(otpRoot));

	// Installed PWAs can't capture the emailed link, so ask the server for a code
	// instead. Detected client-side (no server header exists); SSR/no-JS → browser.
	const mode = $derived(
		browser &&
			(window.matchMedia('(display-mode: standalone)').matches ||
				(navigator as unknown as { standalone?: boolean }).standalone === true)
			? 'standalone'
			: 'browser'
	);

	const result = $derived(form && 'result' in form ? form.result : null);
	const method = $derived(form && 'method' in form ? form.method : null);
	const email = $derived(form && 'email' in form ? form.email : '');
	const failMessage = $derived(form && 'message' in form ? form.message : null);
	const codeError = $derived(form && 'codeError' in form ? form.codeError : null);
	const onCodeStep = $derived(
		(form && 'step' in form && form.step === 'code') || (result === 'sent' && method === 'code')
	);
	// What we'll actually send from the initial step, given the detected mode.
	const noun = $derived(mode === 'standalone' ? 'code' : 'link');
	// Client-side mirror of the server's code check (the server stays authoritative).
	const codeValid = $derived(/^\d{6}$/.test(code));

	const track = () => {
		submitting = true;
		return async ({ update }: { update: () => Promise<void> }) => {
			await update();
			submitting = false;
		};
	};
	const trackCode = () => {
		submitting = true;
		return async ({ update }: { update: () => Promise<void> }) => {
			await update();
			submitting = false;
			code = ''; // clear on a failed attempt so the user can retype (success redirects away)
		};
	};
</script>

<svelte:head>
	<title>Sign in · Marquee</title>
</svelte:head>

<main class="flex min-h-svh items-center justify-center p-4">
	<Card.Root class="w-full max-w-sm">
		{#if result === 'sent' && method === 'link'}
			<Card.Header>
				<Card.Title>Check your inbox</Card.Title>
				<Card.Description>
					We sent a sign-in link to <strong>{email}</strong>. It expires in {data.linkTtlMinutes}
					minutes.
				</Card.Description>
			</Card.Header>
		{:else if onCodeStep}
			<Card.Header>
				<Card.Title>Enter your code</Card.Title>
				<Card.Description>
					We emailed a 6-digit code to <strong>{email}</strong>. It expires in {data.codeTtlMinutes}
					minutes.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<form
					bind:this={codeForm}
					method="POST"
					action="?/verify"
					class="flex flex-col gap-4"
					use:enhance={trackCode}
				>
					<input type="hidden" name="email" value={email} />
					<input type="hidden" name="code" value={code} />
					<InputOTP.Root
						bind:ref={otpRoot}
						maxlength={6}
						bind:value={code}
						autocomplete="one-time-code"
						inputmode="numeric"
						disabled={submitting}
						class="justify-center"
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
						<p class="text-center text-sm text-destructive">{codeError}</p>
					{/if}
					<Button type="submit" disabled={submitting || !codeValid}>
						{submitting ? 'Verifying…' : 'Verify code'}
					</Button>
					<a href={resolve('/login')} class="text-center text-sm text-muted-foreground underline">
						Use a different email
					</a>
				</form>
			</Card.Content>
		{:else if result === 'waitlisted'}
			<Card.Header>
				<Card.Title>You're on the waitlist</Card.Title>
				<Card.Description>
					Thanks for your interest — we'll email <strong>{email}</strong> when your account is ready.
				</Card.Description>
			</Card.Header>
		{:else if result === 'blocked'}
			<Card.Header>
				<Card.Title>Account unavailable</Card.Title>
				<Card.Description>
					This account can't sign in. If you think this is a mistake, get in touch.
				</Card.Description>
			</Card.Header>
		{:else if result === 'unknown'}
			<Card.Header>
				<Card.Title>Join the waitlist</Card.Title>
				<Card.Description>
					<strong>{email}</strong> isn't on the list yet. Want to join the waitlist?
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<form method="POST" action="?/join" class="flex flex-col gap-3" use:enhance={track}>
					<input type="hidden" name="email" value={email} />
					<Button type="submit" disabled={submitting}>
						{submitting ? 'Joining…' : 'Join the waitlist'}
					</Button>
				</form>
			</Card.Content>
		{:else}
			<Card.Header>
				<Card.Title>Sign in to Marquee</Card.Title>
				<Card.Description>
					Enter your email and we'll send you a one-time sign-in {noun}.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<form method="POST" action="?/request" class="flex flex-col gap-3" use:enhance={track}>
					<input type="hidden" name="mode" value={mode} />
					<Input
						bind:ref={emailInput}
						type="email"
						name="email"
						placeholder="you@example.com"
						autocomplete="email"
						required
						aria-label="Email address"
						value={email}
					/>
					{#if result === 'rate_limited'}
						<p class="text-sm text-destructive">Too many requests — try again in a little while.</p>
					{:else if result === 'already'}
						<p class="text-sm text-muted-foreground">
							You're already registered. Request a sign-in link above.
						</p>
					{:else if failMessage}
						<p class="text-sm text-destructive">{failMessage}</p>
					{:else if !form && data.linkError}
						<p class="text-sm text-destructive">{data.linkError}</p>
					{/if}
					<Button type="submit" disabled={submitting}>
						{submitting ? 'Sending…' : `Send sign-in ${noun}`}
					</Button>
				</form>
			</Card.Content>
		{/if}
	</Card.Root>
</main>
