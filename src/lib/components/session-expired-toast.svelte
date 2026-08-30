<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { session } from '$lib/client/session.svelte';

	/**
	 * A persistent toast when the session expires. Mounted in the root layout beside `<ErrorReporter />`
	 * and built the same way: watch the state, raise the sonner. `duration: Infinity` because this is a
	 * *state*, not an event — it should not time out. The action navigates to `/login`.
	 *
	 * The guard on `announced` prevents multiple toasts when multiple channels 401 in the same cycle.
	 */
	$effect(() => {
		if (!session.expired || session.announced) return;
		session.announced = true;

		toast.error("You've been signed out", {
			description: 'Your session expired. Sign in again to keep syncing.',
			duration: Infinity,
			action: {
				label: 'Sign in',
				onClick: () => goto(resolve('/login'))
			}
		});
	});
</script>

<!-- State-driven component: no visible surface of its own — the toast API does the rendering. -->