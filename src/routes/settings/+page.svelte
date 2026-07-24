<script lang="ts">
	import { afterNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import AccountCard from './account-card.svelte';
	import AppearanceCard from './appearance-card.svelte';
	import DeleteAccountCard from './delete-account-card.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Pop history so Settings doesn't stack a duplicate `/` entry; fall back to
	// navigating home when opened directly (no in-app history to pop).
	let cameFromApp = $state(false);
	afterNavigate((nav) => {
		cameFromApp = nav.from != null;
	});

	function goBack() {
		if (cameFromApp) history.back();
		else goto(resolve('/'));
	}
</script>

<svelte:head>
	<title>Settings · Marquee</title>
</svelte:head>

<main class="mx-auto flex w-full max-w-2xl flex-col gap-4 px-5 py-4">
	<div class="flex items-center gap-3">
		<Button
			onclick={goBack}
			variant="outline"
			size="icon"
			shape="round"
			class="text-muted-foreground"
			aria-label="Go back"
		>
			<ChevronLeftIcon class="size-4" />
		</Button>
		<h1 class="font-serif text-xl font-semibold">Settings</h1>
	</div>

	<AccountCard user={data.user} codeTtlMinutes={data.codeTtlMinutes} {form} />
	<AppearanceCard />
	<DeleteAccountCard userEmail={data.user.email} {form} />
</main>
