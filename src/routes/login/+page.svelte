<script lang="ts">
	import { enhance } from '$app/forms';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
	let submitting = $state(false);
</script>

<svelte:head>
	<title>Sign in · Marquee</title>
</svelte:head>

<main class="flex min-h-svh items-center justify-center p-4">
	<Card.Root class="w-full max-w-sm">
		{#if form && 'sent' in form}
			<Card.Header>
				<Card.Title>Check your inbox</Card.Title>
				<Card.Description>
					We sent a sign-in link to <strong>{form.email}</strong>. It expires in 15 minutes.
				</Card.Description>
			</Card.Header>
		{:else}
			<Card.Header>
				<Card.Title>Sign in to Marquee</Card.Title>
				<Card.Description
					>Enter your email and we'll send you a one-time sign-in link.</Card.Description
				>
			</Card.Header>
			<Card.Content>
				<form
					method="POST"
					class="flex flex-col gap-3"
					use:enhance={() => {
						submitting = true;
						return async ({ update }) => {
							await update();
							submitting = false;
						};
					}}
				>
					<Input
						type="email"
						name="email"
						placeholder="you@example.com"
						autocomplete="email"
						required
						aria-label="Email address"
						value={form && 'email' in form ? form.email : ''}
					/>
					{#if form && 'message' in form}
						<p class="text-sm text-destructive">{form.message}</p>
					{/if}
					<Button type="submit" disabled={submitting}>
						{submitting ? 'Sending…' : 'Send sign-in link'}
					</Button>
				</form>
			</Card.Content>
		{/if}
	</Card.Root>
</main>
