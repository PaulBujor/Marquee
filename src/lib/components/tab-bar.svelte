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

	// Publish the bar's height, as two properties with different jobs — font scaling means the CSS
	// baselines in layout.css are only estimates.
	//
	// `--tab-bar-space` is what pages pad by, and a collapsed height is never published to it. That
	// padding must not SHRINK mid-scroll: doing so moves the scroll position, which feeds the
	// compaction fold above, and the two oscillate. (On the way back up it does ease along with the
	// bar for a frame or two, since `compact` clears before the height animation finishes — growing
	// padding below the fold is harmless and can't drive that loop.)
	//
	// `--tab-bar-live` tracks the height right now, collapsed or not, and positions the things that
	// float directly above the bar (toasts, the undo pill). They're fixed overlays, so following the
	// bar down costs no reflow and can't feed that loop — whereas leaving them on the pinned value
	// would visibly open a gap every time the bar collapsed.
	let card = $state<HTMLElement | null>(null);
	$effect(() => {
		const el = card;
		if (!el) return;
		const publish = (height: number) => {
			const space = `calc(${height}px + max(0.75rem, env(safe-area-inset-bottom)))`;
			document.documentElement.style.setProperty('--tab-bar-live', space);
			if (!compact) document.documentElement.style.setProperty('--tab-bar-space', space);
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
			document.documentElement.style.removeProperty('--tab-bar-live');
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
	class="pointer-events-none fixed inset-x-0 bottom-0 z-40 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] transition-[transform,opacity] duration-200 motion-reduce:transition-none {keyboard
		? 'translate-y-full opacity-0'
		: ''}"
>
	<!-- `glass` is the shared frosted material (see layout.css) — it carries the tint, blur and the
	luminance wash that keeps these labels legible over artwork, and the same class is on the
	scroll-undo pill so the two read as one surface. -->
	<ul
		bind:this={card}
		class="glass pointer-events-auto mx-auto flex w-full max-w-md items-stretch justify-around gap-1 rounded-full border border-border p-1.5 shadow-[0_4px_12px_rgb(0_0_0/0.1)] sm:max-w-fit sm:gap-0.5"
	>
		{#each TABS as def (def.id)}
			{@const Icon = ICONS[def.id]}
			{@const isSelected = selected === def.id}
			<li class="flex min-w-0 flex-1 sm:flex-none">
				<!-- eslint-disable svelte/no-navigation-without-resolve -- a remembered destination
				carries a query string, which drops resolve()'s branded type; `tabHref` has already
				validated the value as an own-tab, same-origin path. -->
				<!-- `aria-current` follows the route we're actually on, not the tinted tab: on a title
				page the owning tab stays lit, but claiming it is the current page would be a lie to a
				screen reader. -->
				<a
					href={tabs.href(def.id)}
					data-sveltekit-noscroll
					aria-current={current === def.id ? 'page' : undefined}
					onclick={(event) => onTabClick(event, def)}
					class="flex min-w-0 flex-1 touch-manipulation flex-col items-center justify-center rounded-full px-1 py-2 transition-[gap] duration-200 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none sm:flex-row sm:gap-2 sm:px-4 sm:py-2.5 {compact
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
						<!-- `leading-none` would put the line box exactly at the font size, so `overflow-hidden`
						above clips the descenders off "Upcoming" and "Settings". Unitless, so it holds at the
						larger `sm:` size too. -->
						<span
							class="overflow-hidden text-[0.6875rem] leading-[1.35] font-medium sm:text-sm {isSelected
								? 'font-semibold'
								: ''}"
						>
							{def.label}
						</span>
					</span>
				</a>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			</li>
		{/each}
	</ul>
</nav>
