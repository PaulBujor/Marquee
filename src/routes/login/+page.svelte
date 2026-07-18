<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let submitting = $state(false);

	const result = $derived(form && 'result' in form ? form.result : null);
	const email = $derived(form && 'email' in form ? form.email : '');
	const failMessage = $derived(form && 'message' in form ? form.message : null);

	const track = () => {
		submitting = true;
		return async ({ update }: { update: () => Promise<void> }) => {
			await update();
			submitting = false;
		};
	};
</script>

<svelte:head>
	<title>Sign in · Marquee</title>
</svelte:head>

<main class="flex min-h-svh items-center justify-center p-4">
	<Card.Root class="w-full max-w-sm">
		{#if result === 'sent'}
			<Card.Header>
				<Card.Title>Check your inbox</Card.Title>
				<Card.Description>
					We sent a sign-in link to <strong>{email}</strong>. It expires in 15 minutes.
				</Card.Description>
			</Card.Header>
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
				<Card.Description
					>Enter your email and we'll send you a one-time sign-in link.</Card.Description
				>
			</Card.Header>
			<Card.Content>
				<form method="POST" action="?/request" class="flex flex-col gap-3" use:enhance={track}>
					<Input
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
						{submitting ? 'Sending…' : 'Send sign-in link'}
					</Button>
				</form>
			</Card.Content>
		{/if}
	</Card.Root>
</main>
