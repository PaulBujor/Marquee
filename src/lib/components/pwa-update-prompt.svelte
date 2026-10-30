<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/env';
	import { toast } from 'svelte-sonner';

	let waiting = $state<ServiceWorker | null>(null);

	const TOAST_ID = 'pwa-update';

	// Dismissible; re-surfaces on the next foreground check while a worker still waits.
	function showUpdateToast() {
		toast('A new version of Marquee is available.', {
			id: TOAST_ID,
			duration: Infinity,
			action: { label: 'Reload', onClick: reload }
		});
	}

	$effect(() => {
		if (waiting) showUpdateToast();
	});

	onMount(() => {
		if (!browser || !('serviceWorker' in navigator)) return;

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

		// Re-check for a deploy on foreground; re-surface the toast if a worker still waits (dismissed earlier).
		const onVisible = () => {
			if (document.visibilityState !== 'visible') return;
			registration?.update();
			if (waiting) showUpdateToast();
		};
		document.addEventListener('visibilitychange', onVisible);

		return () => {
			document.removeEventListener('visibilitychange', onVisible);
		};
	});

	function reload(event: MouseEvent) {
		// Keep the toast (Sonner dismisses it on action click) and swap it to a loading state.
		event.preventDefault();
		toast.loading('Reloading…', { id: TOAST_ID, duration: Infinity });
		waiting?.postMessage({ type: 'SKIP_WAITING' });
	}
</script>
