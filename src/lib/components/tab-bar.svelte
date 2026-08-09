<script lang="ts">
	// The app's primary navigation: a floating, translucent card pinned to the bottom of every
	// signed-in page, so the four destinations stay in thumb reach instead of in the far top corner.
	//
	// Three behaviours make it read as an app rather than four links:
	//   - each tab links to where you last were on it (URL + scroll), not to its bare root;
	//   - tapping the tab you're already on acts on the page — search focuses its field, everything
	//     else scrolls to the top (the dashboard offers an undo, since its position is expensive);
	//   - the labels collapse away as you scroll down and come back as you scroll up.
	// The decisions behind all three live in `$lib/state/tabs` as pure, tested helpers.
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { prefersReducedMotion } from 'svelte/motion';
	import { tabs } from '$lib/state/tabs.svelte.js';
	import {
		TABS,
		activeTab,
		foldScroll,
		initialScrollPhase,
		isKeyboardOpen,
		tabAction,
		type ScrollPhase,
		type TabDef,
		type TabId
	} from '$lib/state/tabs';
	import CalendarDaysIcon from '@lucide/svelte/icons/calendar-days';
	import LayoutGridIcon from '@lucide/svelte/icons/layout-grid';
	import SearchIcon from '@lucide/svelte/icons/search';
	import SettingsIcon from '@lucide/svelte/icons/settings';

	const ICONS: Record<TabId, typeof LayoutGridIcon> = {
		dashboard: LayoutGridIcon,
		timeline: CalendarDaysIcon,
		settings: SettingsIcon,
		search: SearchIcon
	};

	// A title page belongs to no tab, so it keeps the tab it was opened from lit — the detail view is
	// a push within that tab's stack, and a title is reachable from the dashboard, search and upcoming
	// alike. `current` (null there) drives what a tap *does*; `selected` only drives what looks active.
	const current = $derived(activeTab(page.url.pathname));
	const selected = $derived(current ?? tabs.owner);

	let compact = $state(false);
	let phase: ScrollPhase = initialScrollPhase;

	// Collapse the labels on the way down, restore them on the way up. Coalesced to one update per
	// frame — this listener runs over the dashboard's very long grid.
	$effect(() => {
		let frame = 0;
		const onScroll = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				const maxY = document.documentElement.scrollHeight - window.innerHeight;
				phase = foldScroll(phase, window.scrollY, maxY);
				compact = phase.compact;
			});
		};
		window.addEventListener('scroll', onScroll, { passive: true });
		return () => {
			if (frame) cancelAnimationFrame(frame);
			window.removeEventListener('scroll', onScroll);
		};
	});

	// A new page starts at the top, so it must start expanded — inheriting the previous page's
	// collapsed bar reads as broken.
	afterNavigate(() => {
		phase = initialScrollPhase;
		compact = false;
	});

	// Get out of the way of the soft keyboard: iOS floats a fixed bottom element above it, covering
	// the field being typed into. Best-effort — browsers without visualViewport just keep the bar.
	let keyboard = $state(false);
	$effect(() => {
		const viewport = window.visualViewport;
		if (!viewport) return;
		const update = () => {
			keyboard = isKeyboardOpen(window.innerHeight, viewport.height);
		};
		update();
		viewport.addEventListener('resize', update);
		return () => viewport.removeEventListener('resize', update);
	});

	// Publish the bar's real height so pages can clear it (`pb-tab-bar`) and toasts can sit above it.
	// Font scaling makes the CSS baseline in layout.css only an estimate.
	let card = $state<HTMLElement | null>(null);
	$effect(() => {
		const el = card;
		if (!el) return;
		// Only ever publish the EXPANDED height. Letting the collapsed one through would shrink every
		// page's bottom padding mid-scroll, shifting the scroll position and feeding the compaction
		// fold above — the two would oscillate.
		const publish = (height: number) => {
			if (compact) return;
			const space = `calc(${height}px + max(0.75rem, env(safe-area-inset-bottom)))`;
			document.documentElement.style.setProperty('--tab-bar-space', space);
		};
		// Measure once up front: a ResizeObserver's first callback isn't guaranteed to arrive (and the
		// API isn't guaranteed to exist), and the CSS baseline is only an estimate.
		publish(el.offsetHeight);
		const observer =
			typeof ResizeObserver === 'undefined'
				? null
				: new ResizeObserver(([entry]) => publish(entry.contentRect.height));
		observer?.observe(el);
		return () => {
			observer?.disconnect();
			document.documentElement.style.removeProperty('--tab-bar-space');
		};
	});

	function onTabClick(event: MouseEvent, def: TabDef) {
		// Leave modified and non-primary clicks alone so open-in-new-tab keeps working.
		if (event.defaultPrevented || event.button !== 0) return;
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

		const action = tabAction({
			id: def.id,
			currentPath: page.url.pathname,
			remembered: tabs.href(def.id),
			scrollY: window.scrollY
		});

		if (action.kind === 'navigate') {
			// Not prevented: the anchor navigates as normal, so history behaves like any other link.
			tabs.armRestore(def.id);
			if (action.focusSearch) tabs.requestSearchFocus();
			return;
		}

		event.preventDefault();
		if (action.kind === 'focus-search') {
			tabs.requestSearchFocus();
			return;
		}
		if (action.undoFrom !== null) tabs.offerUndo(action.undoFrom);
		window.scrollTo({ top: 0, behavior: prefersReducedMotion.current ? 'auto' : 'smooth' });
	}
</script>

<!-- The wrapper is click-through (`pointer-events-none`) so the gap either side of the card doesn't
swallow taps on the content behind it; the card itself takes pointer events back. `preload-data`
narrows the body-level "hover" default to "tap": hovering Search would otherwise re-run its load and
fire a TMDB request on every pass of the cursor. -->
<nav
	aria-label="Primary"
	data-sveltekit-preload-data="tap"
	style="view-transition-name: marquee-tab-bar"
	class="pointer-events-none fixed inset-x-0 bottom-0 z-40 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] transition-[transform,opacity] duration-200 motion-reduce:transition-none {keyboard
		? 'translate-y-full opacity-0'
		: ''}"
>
	<!-- Surface deliberately matches a Sonner toast — same popover background, border and shadow — so
	the two floating layers at the bottom of the screen read as one material. -->
	<ul
		bind:this={card}
		class="pointer-events-auto mx-auto flex w-full max-w-md items-stretch justify-around gap-1 rounded-full border border-border bg-popover/95 p-1.5 shadow-[0_4px_12px_rgb(0_0_0/0.1)] supports-backdrop-filter:bg-popover/60 supports-backdrop-filter:backdrop-blur-2xl supports-backdrop-filter:backdrop-saturate-150 sm:max-w-fit sm:gap-0.5"
	>
		{#each TABS as def (def.id)}
			{@const Icon = ICONS[def.id]}
			{@const isSelected = selected === def.id}
			<li class="flex min-w-0 flex-1 sm:flex-none">
				<!-- eslint-disable svelte/no-navigation-without-resolve -- a remembered destination
				carries a query string, which drops resolve()'s branded type; `tabHref` has already
				validated the value as an own-tab, same-origin path. -->
				<a
					href={tabs.href(def.id)}
					data-sveltekit-noscroll
					aria-current={isSelected ? 'page' : undefined}
					title={def.label}
					onclick={(event) => onTabClick(event, def)}
					class="flex min-w-0 flex-1 touch-manipulation flex-col items-center justify-center rounded-full px-1 py-2 outline-none transition-[gap] duration-200 focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none sm:flex-row sm:gap-2 sm:px-4 sm:py-2.5 {compact
						? 'gap-0'
						: 'gap-1'} {isSelected
						? 'text-primary sm:bg-primary/10'
						: 'text-muted-foreground sm:hover:bg-accent sm:hover:text-foreground'}"
				>
					<span
						class="relative flex h-8 w-14 shrink-0 items-center justify-center sm:h-auto sm:w-auto"
					>
						<!-- Active indicator: the tint alone can't carry the state at this size, and Lucide
						has no filled variants to switch to. -->
						<span
							class="absolute inset-0 rounded-full bg-primary/12 transition-opacity duration-200 motion-reduce:transition-none sm:hidden {isSelected
								? 'opacity-100'
								: 'opacity-0'}"
						></span>
						<Icon class="relative size-5" />
					</span>
					<!-- Collapsing wrapper: animating grid-template-rows 1fr→0fr is the one way to ease to
					an intrinsic height. `overflow-hidden` on the inner span is what lets the row actually
					reach zero (a grid item's automatic minimum size only collapses when its overflow isn't
					visible), and `min-h-0` does the same for the wrapper as a flex child. The gap above the
					label lives on the anchor, not here — padding inside the collapsing box can't shrink
					past itself under border-box, and the few pixels left behind push the icon off centre.
					Kept out of the `hidden` family so the label stays in the accessibility tree. -->
					<span
						class="grid min-h-0 transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none sm:grid-rows-[1fr]! sm:opacity-100! {compact
							? 'grid-rows-[0fr] opacity-0'
							: 'grid-rows-[1fr] opacity-100'}"
					>
						<span
							class="overflow-hidden text-[0.6875rem] leading-none font-medium sm:text-sm {isSelected
								? 'font-semibold'
								: ''}"
						>
							{def.label}
						</span>
					</span>
				</a>
			</li>
		{/each}
	</ul>
</nav>
