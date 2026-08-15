<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import ErrorLogDialog from '$lib/components/error-log-dialog.svelte';
	import { errorLog } from '$lib/client/errors.svelte';

	/**
	 * A way back to the error log after the toast that announced it has gone. Without this the log
	 * would only be reachable in the seconds a toast is on screen, which is exactly when a user is
	 * least likely to want to read a stack trace.
	 */
	let open = $state(false);
	const count = $derived(errorLog.entries.length);
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Diagnostics</Card.Title>
		<Card.Description>
			{#if count === 0}
				Nothing has gone wrong on this device this session.
			{:else}
				{count}
				{count === 1 ? 'error' : 'errors'} recorded on this device this session. Copying the log into
				a bug report is the fastest way to get something fixed.
			{/if}
		</Card.Description>
	</Card.Header>
	<Card.Content>
		<Button variant="outline" onclick={() => (open = true)} disabled={count === 0}>
			View error log
		</Button>
	</Card.Content>
</Card.Root>

<ErrorLogDialog bind:open />
