<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { goto } from '$app/navigation';
	import { session } from '#lib/client/session.svelte.js';
	import { loginPathWithRedirect } from '#lib/redirect.js';

	/** `duration: Infinity` because this is a *state*, not an event; `announced` keeps it to one toast. */
	$effect(() => {
		if (!session.expired || session.announced) return;
		session.announced = true;

		toast.error("You've been signed out", {
			description: 'Your session expired. Sign in again to keep syncing.',
			duration: Infinity,
			action: {
				label: 'Sign in',
				// Carry the current page through sign-in — losing it is what makes an expiry feel like a kick-out.
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
