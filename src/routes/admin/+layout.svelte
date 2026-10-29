<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import { navigating, page } from '$app/state';
	import { resolve } from '$app/paths';
	import PageHeader from '#lib/components/page-header.svelte';

	let { children }: { children: Snippet } = $props();

	// Nothing on the admin surface is cached for offline use (see the `/admin` opt-out in the service
	// worker), so an offline client shows an explanation instead of a soft navigation into a dead page.
	let online = $state(true);
	onMount(() => {
		online = navigator.onLine;
	});

	// Only a route change gets the skeleton. A filter, sort or search navigation re-runs the same page's
	// load, and blanking the table under someone who is typing would be worse than leaving it in place.
	const pending = $derived(
		!!navigating.to &&
			navigating.to.url.pathname.startsWith('/admin') &&
			navigating.to.url.pathname !== page.url.pathname
	);

	const tabs = [
		{ path: '/admin' as const, label: 'Overview' },
		{ path: '/admin/users' as const, label: 'Users' },
		{ path: '/admin/audit' as const, label: 'Audit' }
	];
</script>

<svelte:head>
	<title>Admin · Marquee</title>
</svelte:head>

<PageHeader>
	<div class="mx-auto w-full max-w-2xl">
		<div class="flex min-h-10 items-center gap-3">
			<h1 class="font-serif text-xl font-semibold">Admin</h1>
		</div>
		<nav class="flex gap-1.5">
			{#each tabs as tab (tab.path)}
				{@const active =
					tab.path === '/admin'
						? page.url.pathname === '/admin'
						: page.url.pathname.startsWith(tab.path)}
				<a
					href={resolve(tab.path)}
					data-sveltekit-preload-data="tap"
					aria-current={active ? 'page' : undefined}
					class="rounded-full px-3 py-1.5 text-sm transition-colors {active
						? 'bg-foreground text-background'
						: 'text-muted-foreground hover:text-foreground'}"
				>
					{tab.label}
				</a>
			{/each}
		</nav>
	</div>
</PageHeader>

<svelte:window ononline={() => (online = true)} onoffline={() => (online = false)} />

<main class="mx-auto w-full max-w-2xl px-5 pt-4 pb-24" aria-busy={pending}>
	{#if pending}
		<div class="space-y-2" aria-hidden="true">
			<div class="h-9 animate-pulse rounded-lg border bg-muted/40"></div>
			{#each Array(5) as _, index (index)}
				<div class="h-12 animate-pulse rounded-lg border bg-muted/30"></div>
			{/each}
		</div>
	{:else if online}
		{@render children()}
	{:else}
		<p class="mt-6 text-sm text-muted-foreground">
			Admin needs a network connection. Nothing here is stored for offline use.
		</p>
	{/if}
</main>
