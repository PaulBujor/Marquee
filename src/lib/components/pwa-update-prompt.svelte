<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { toast } from 'svelte-sonner';

	// Surface a waiting (freshly deployed) worker; swap only on user accept.
	let waiting = $state<ServiceWorker | null>(null);

	const TOAST_ID = 'pwa-update';

	// Dismissible toast; re-surfaces on the next foreground update check while a worker still waits.
	function showUpdateToast() {
		toast('A new version of Marquee is available.', {
			id: TOAST_ID,
			duration: Infinity,
			action: { label: 'Reload', onClick: reload }
		});
	}

	// Fire the toast once a worker is waiting.
	$effect(() => {
		if (waiting) showUpdateToast();
	});

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

		// Re-check for a deploy when the app returns to the foreground; re-surface the toast if a
		// worker is still waiting (the user may have dismissed it earlier).
		const onVisible = () => {
			if (document.visibilityState !== 'visible') return;
			registration?.update();
			if (waiting) showUpdateToast();
		};
		document.addEventListener('visibilitychange', onVisible);

		return () => {
			navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});

	function reload(event: MouseEvent) {
		// Keep the toast (Sonner would otherwise dismiss it on action click) and swap it to a
		// loading state until `controllerchange` reloads the page.
		event.preventDefault();
		toast.loading('Reloading…', { id: TOAST_ID, duration: Infinity });
		waiting?.postMessage({ type: 'SKIP_WAITING' });
	}
</script>
