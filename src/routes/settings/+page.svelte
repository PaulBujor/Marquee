<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import AccountCard from './account-card.svelte';
	import AppearanceCard from './appearance-card.svelte';
	import DeleteAccountCard from './delete-account-card.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head>
	<title>Settings · Marquee</title>
</svelte:head>

<main class="mx-auto flex w-full max-w-lg flex-col gap-6 p-6">
	<div class="flex items-center gap-3">
		<Button
			href={resolve('/')}
			variant="outline"
			size="icon"
			shape="round"
			class="text-muted-foreground"
			aria-label="Back to home"
		>
			<ChevronLeftIcon class="size-4" />
		</Button>
		<h1 class="font-serif text-2xl font-semibold">Settings</h1>
	</div>

	<AccountCard user={data.user} codeTtlMinutes={data.codeTtlMinutes} {form} />
	<AppearanceCard />
	<DeleteAccountCard userEmail={data.user.email} {form} />
</main>
