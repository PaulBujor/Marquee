<script lang="ts">
	import CloudOff from '@lucide/svelte/icons/cloud-off';
	import EmptyState from './empty-state.svelte';

	// A friendly placeholder for data that isn't cached and can't be fetched offline. Wraps
	// the shared empty-state with a consistent cloud-off icon + message.
	let {
		message = "This isn't available offline.",
		class: className
	}: { message?: string; class?: string } = $props();
</script>

<EmptyState icon={CloudOff} {message} class={className} />
