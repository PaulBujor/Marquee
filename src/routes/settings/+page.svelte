<script lang="ts">
	import PageHeader from '$lib/components/page-header.svelte';
	import AccountCard from './account-card.svelte';
	import AppearanceCard from './appearance-card.svelte';
	import NotificationsCard from './notifications-card.svelte';
	import DataCacheCard from './data-cache-card.svelte';
	import DataPortabilityCard from './data-portability-card.svelte';
	import CreditsCard from './credits-card.svelte';
	import DeleteAccountCard from './delete-account-card.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head>
	<title>Settings · Marquee</title>
</svelte:head>

<!-- No back control: this is a tab root, reachable from anywhere. `min-h-10` holds the header at the
same height as the ones that do carry a 40px control, so the sticky offsets stay uniform. -->
<PageHeader>
	<div class="flex min-h-10 items-center gap-3">
		<h1 class="font-serif text-xl font-semibold">Settings</h1>
	</div>
</PageHeader>

<main class="mx-auto flex w-full max-w-2xl flex-col gap-4 px-5 pt-3 pb-tab-bar">
	<AccountCard user={data.user} codeTtlMinutes={data.codeTtlMinutes} {form} />
	<AppearanceCard />
	<NotificationsCard />
	<DataCacheCard />
	<DataPortabilityCard />
	<CreditsCard />
	<DeleteAccountCard userEmail={data.user.email} {form} />
</main>
