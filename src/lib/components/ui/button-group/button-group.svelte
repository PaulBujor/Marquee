<script lang="ts" module>
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';
	import { type VariantProps, tv } from 'tailwind-variants';

	export const buttonGroupVariants = tv({
		base: "flex w-fit items-stretch has-[>[data-slot=button-group]]:gap-2 [&>*]:relative [&>*]:focus-visible:z-10 [&>[data-slot=select-trigger]:not([class*='w-'])]:w-fit [&>input]:flex-1",
		variants: {
			orientation: {
				horizontal:
					'[&>*:not(:first-child)]:rounded-l-none [&>*:not(:first-child)]:border-l-0 [&>*:not(:last-child)]:rounded-r-none',
				vertical:
					'flex-col [&>*:not(:first-child)]:rounded-t-none [&>*:not(:first-child)]:border-t-0 [&>*:not(:last-child)]:rounded-b-none'
			}
		},
		defaultVariants: {
			orientation: 'horizontal'
		}
	});

	export type ButtonGroupOrientation = VariantProps<typeof buttonGroupVariants>['orientation'];

	export type ButtonGroupProps = WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		orientation?: ButtonGroupOrientation;
	};
</script>

<script lang="ts">
	let {
		class: className,
		orientation = 'horizontal',
		ref = $bindable(null),
		children,
		...restProps
	}: ButtonGroupProps = $props();
</script>

<div
	bind:this={ref}
	data-slot="button-group"
	data-orientation={orientation}
	role="group"
	class={cn(buttonGroupVariants({ orientation }), className)}
	{...restProps}
>
	{@render children?.()}
</div>
