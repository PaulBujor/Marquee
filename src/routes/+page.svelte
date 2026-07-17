<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<main class="mx-auto flex min-h-svh max-w-2xl flex-col items-start justify-center gap-4 p-6">
	<h1 class="text-3xl font-semibold">Marquee</h1>
	{#if data.user}
		<p class="text-muted-foreground">
			Signed in as <strong>{data.user.email}</strong>.
		</p>
		<form method="POST" action="?/logout" use:enhance>
			<Button type="submit" variant="outline">Sign out</Button>
		</form>
	{:else}
		<p class="text-muted-foreground">Track the movies and shows you're watching.</p>
		<a href={resolve('/login')} class={buttonVariants()}>Sign in</a>
	{/if}
</main>
