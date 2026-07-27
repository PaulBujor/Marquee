<script lang="ts">
	import PageHeader from '$lib/components/page-header.svelte';
	import BackButton from '$lib/components/back-button.svelte';
	import AccountCard from './account-card.svelte';
	import AppearanceCard from './appearance-card.svelte';
	import NotificationsCard from './notifications-card.svelte';
	import DataCacheCard from './data-cache-card.svelte';
	import DeleteAccountCard from './delete-account-card.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head>
	<title>Settings · Marquee</title>
</svelte:head>

<PageHeader>
	<div class="flex items-center gap-3">
		<BackButton />
		<h1 class="font-serif text-xl font-semibold">Settings</h1>
	</div>
</PageHeader>

<main class="mx-auto flex w-full max-w-2xl flex-col gap-4 px-5 pt-3 pb-16">
	<AccountCard user={data.user} codeTtlMinutes={data.codeTtlMinutes} {form} />
	<AppearanceCard />
	<NotificationsCard />
	<DataCacheCard />
	<DeleteAccountCard userEmail={data.user.email} {form} />
</main>
