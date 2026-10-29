<script lang="ts">
	import { onMount } from 'svelte';
	import PageHeader from '#lib/components/page-header.svelte';
	import AccountCard from './account-card.svelte';
	import AppearanceCard from './appearance-card.svelte';
	import NotificationsCard from './notifications-card.svelte';
	import DataCacheCard from './data-cache-card.svelte';
	import DataPortabilityCard from './data-portability-card.svelte';
	import DiagnosticsCard from './diagnostics-card.svelte';
	import CreditsCard from './credits-card.svelte';
	import AdminCard from './admin-card.svelte';
	import DeleteAccountCard from './delete-account-card.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let online = $state(true);
	onMount(() => {
		online = navigator.onLine;
	});
</script>

<svelte:window ononline={() => (online = true)} onoffline={() => (online = false)} />

<svelte:head>
	<title>Settings · Marquee</title>
</svelte:head>

<!-- No back control: tab root. `min-h-10` keeps the header height uniform so the sticky offsets line up. -->
<PageHeader>
	<div class="flex min-h-10 items-center gap-3">
		<h1 class="font-serif text-xl font-semibold">Settings</h1>
	</div>
</PageHeader>

<main
	class="mx-auto grid w-full max-w-3xl grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4 px-5 pt-3 pb-tab-bar"
>
	{#if data.isAdmin && online}
		<AdminCard />
	{/if}
	<AccountCard user={data.user} codeTtlMinutes={data.codeTtlMinutes} {form} />
	<AppearanceCard />
	<NotificationsCard />
	<DataCacheCard />
	<DataPortabilityCard />
	<DiagnosticsCard />
	<CreditsCard />
	<DeleteAccountCard userEmail={data.user.email} {form} />
</main>
