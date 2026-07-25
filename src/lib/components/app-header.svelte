<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import HeaderScrim from '$lib/components/header-scrim.svelte';
	import CalendarDaysIcon from '@lucide/svelte/icons/calendar-days';
	import SearchIcon from '@lucide/svelte/icons/search';
	import SettingsIcon from '@lucide/svelte/icons/settings';
</script>

<!-- Sticky app header: content scrolls blurred beneath it, faded out by a top→transparent
gradient. Aligned to the dashboard's max-w-2xl content column; clears the iOS status bar. -->
<header class="sticky top-0 z-40">
	<HeaderScrim />
	<div
		class="relative mx-auto flex w-full max-w-3xl items-center justify-between px-5 pt-[max(1rem,env(safe-area-inset-top))] pb-4"
	>
		<a href={resolve('/')} class="font-serif text-xl font-semibold">Marquee</a>
		<div class="flex items-center gap-2">
			<Button
				href={resolve('/timeline')}
				variant="outline"
				size="icon"
				shape="round"
				class="text-muted-foreground"
				title="Upcoming"
				aria-label="Upcoming releases"
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
