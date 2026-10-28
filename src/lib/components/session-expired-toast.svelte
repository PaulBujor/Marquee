<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { goto } from '$app/navigation';
	import { session } from '$lib/client/session.svelte';
	import { loginPathWithRedirect } from '$lib/redirect';

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
				// Carry the current page through sign-in: an expiry mid-browse is the most common
				// way to end up here, and losing the page is what makes it feel like a kick-out.
				onClick: () => {
					const target = loginPathWithRedirect(
						`${window.location.pathname}${window.location.search}`
					);
					// eslint-disable-next-line svelte/no-navigation-without-resolve
					goto(target);
				}
			}
		});
	});
</script>

<!-- State-driven component: no visible surface of its own — the toast API does the rendering. -->
