<script lang="ts">
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ErrorLogDialog from './error-log-dialog.svelte';
	import { errorLog } from '$lib/client/errors.svelte';

	/**
	 * Turns every reported error into something the user can see and read.
	 *
	 * The reporting itself already existed and was entirely silent — uncaught throws, rejected
	 * promises and hook errors went to the server log and nowhere else, so the only symptom of a
	 * broken app was a control that did nothing. This is the visible half: a toast when something
	 * breaks, and the full message and stack one tap away.
	 *
	 * Mounted once in the root layout. Errors a caller has already explained in its own words are
	 * logged but not re-announced (see `handled` on the report).
	 */
	let dialogOpen = $state(false);

	/**
	 * Toasts per session. An error that fires in a loop is already folded into one log entry, but a
	 * page breaking in several different ways at once shouldn't bury the app under toasts — after
	 * this many, the log keeps recording silently and the settings entry point is the way in.
	 */
	const MAX_TOASTS = 3;
	let shown = 0;

	onMount(() => errorLog.start());

	$effect(() => {
		const entry = errorLog.pending;
		if (!entry) return;
		// Clear first: showing the toast must not be able to re-enter this effect.
		errorLog.pending = null;
		if (shown >= MAX_TOASTS) return;
		shown += 1;

		toast.error('Something went wrong', {
			description: entry.message,
			duration: 8000,
			action: {
				label: 'See error',
				onClick: () => (dialogOpen = true)
			}
		});
	});
</script>

<ErrorLogDialog bind:open={dialogOpen} />
