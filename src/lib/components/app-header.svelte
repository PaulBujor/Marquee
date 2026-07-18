<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import CalendarDaysIcon from '@lucide/svelte/icons/calendar-days';
	import SearchIcon from '@lucide/svelte/icons/search';
	import SettingsIcon from '@lucide/svelte/icons/settings';

	// Circular icon buttons, matching the reference. Timeline and Search are
	// roadmap features (MRQ Timeline / TMDB search) — rendered disabled for now.
</script>

<header class="flex items-center justify-between px-5 py-4">
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
			size="icon"
			shape="round"
			disabled
			title="Search — coming soon"
			aria-label="Search (coming soon)"
		>
			<SearchIcon class="size-4" />
		</Button>
	</div>
</header>
