<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import CalendarDaysIcon from '@lucide/svelte/icons/calendar-days';
	import SearchIcon from '@lucide/svelte/icons/search';
	import SettingsIcon from '@lucide/svelte/icons/settings';
</script>

<!-- Sticky app header: content scrolls blurred beneath it, faded out by a top→transparent
gradient. Aligned to the dashboard's max-w-2xl content column; clears the iOS status bar. -->
<header class="sticky top-0 z-40">
	<!-- Progressive blur: masking the backdrop-filter with a curved top→transparent alpha gradient
	fades the blur out gradually (no hard cut-off line). Same curve across all headers. -->
	<div
		class="pointer-events-none absolute inset-0 backdrop-blur-md"
		style="background:linear-gradient(to bottom, var(--color-background) 0%, var(--color-background) 18%, color-mix(in oklab, var(--color-background) 72%, transparent) 42%, color-mix(in oklab, var(--color-background) 28%, transparent) 66%, transparent 100%); -webkit-mask-image:linear-gradient(to bottom, #000 0%, #000 42%, rgb(0 0 0 / 0.55) 64%, rgb(0 0 0 / 0.2) 84%, transparent 100%); mask-image:linear-gradient(to bottom, #000 0%, #000 42%, rgb(0 0 0 / 0.55) 64%, rgb(0 0 0 / 0.2) 84%, transparent 100%);"
	></div>
	<div
		class="relative mx-auto flex w-full max-w-3xl items-center justify-between px-5 pt-[max(1rem,env(safe-area-inset-top))] pb-4"
	>
		<a href={resolve('/')} class="font-serif text-xl font-semibold">Marquee</a>
		<div class="flex items-center gap-2">
			<Button
				variant="outline"
				size="icon"
				shape="round"
				class="text-muted-foreground"
				disabled
				title="Timeline — coming soon"
				aria-label="Timeline (coming soon)"
			>
				<CalendarDaysIcon class="size-4" />
			</Button>
			<Button
				href={resolve('/settings')}
				variant="outline"
				size="icon"
				shape="round"
				class="text-muted-foreground"
				title="Settings"
				aria-label="Settings"
			>
				<SettingsIcon class="size-4" />
			</Button>
			<Button
				href={resolve('/search')}
				size="icon"
				shape="round"
				title="Search"
				aria-label="Search"
			>
				<SearchIcon class="size-4" />
			</Button>
		</div>
	</div>
</header>
