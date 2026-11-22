<script lang="ts">
	import CloudOff from '@lucide/svelte/icons/cloud-off';
	import EmptyState from './empty-state.svelte';

	let {
		message = "This isn't available offline.",
		class: className
	}: { message?: string; class?: string } = $props();
</script>

<EmptyState icon={CloudOff} {message} class={className} />
