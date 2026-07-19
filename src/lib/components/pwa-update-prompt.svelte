<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';

	// Surface a waiting (freshly deployed) worker; swap only on user accept.
	let waiting = $state<ServiceWorker | null>(null);

	onMount(() => {
		if (!browser || !('serviceWorker' in navigator)) return;

		let reloading = false;
		const onControllerChange = () => {
			if (reloading) return;
			reloading = true;
			location.reload();
		};
		navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

		let registration: ServiceWorkerRegistration | undefined;

		const track = (reg: ServiceWorkerRegistration) => {
			registration = reg;
			// A controller means this is an update, not the first install.
			if (reg.waiting && navigator.serviceWorker.controller) waiting = reg.waiting;
			reg.addEventListener('updatefound', () => {
				const installing = reg.installing;
				if (!installing) return;
				installing.addEventListener('statechange', () => {
					if (installing.state === 'installed' && navigator.serviceWorker.controller) {
						waiting = reg.waiting;
					}
				});
			});
		};

		navigator.serviceWorker.getRegistration().then((reg) => {
			if (reg) track(reg);
		});

		// Re-check for a deploy when the app returns to the foreground.
		const onVisible = () => {
			if (document.visibilityState === 'visible') registration?.update();
		};
		document.addEventListener('visibilitychange', onVisible);

		return () => {
			navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});

	function reload() {
		waiting?.postMessage({ type: 'SKIP_WAITING' });
	}
</script>

{#if waiting}
	<Card.Root
		role="status"
		class="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-md flex-row items-center gap-3 px-4 py-3 shadow-lg sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2"
	>
		<span class="flex-1 text-sm">A new version of Marquee is available.</span>
		<Button size="sm" onclick={reload}>Reload</Button>
	</Card.Root>
{/if}
