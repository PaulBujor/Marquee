<script lang="ts">
	import type { HTMLOptgroupAttributes } from 'svelte/elements';

	let { children, ...restProps }: HTMLOptgroupAttributes = $props();
</script>

<optgroup data-slot="native-select-opt-group" {...restProps}>
	{@render children?.()}
</optgroup>
