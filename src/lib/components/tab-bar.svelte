<script lang="ts">
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { prefersReducedMotion } from 'svelte/motion';
	import { tabs } from '#lib/state/tabs.svelte.js';
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
	} from '#lib/state/tabs.js';
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

	// A title page belongs to no tab, so it keeps the opened-from tab lit: `current` (null there) drives
	// what a tap does; `selected` only drives what looks active.
	const current = $derived(activeTab(page.url.pathname));
	const selected = $derived(current ?? tabs.owner);

	const navTabs = $derived(TABS);

	let compact = $state(false);
	let phase: ScrollPhase = initialScrollPhase;

	// Coalesced to one update per frame — this listener runs over the dashboard's very long grid.
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

	// A new page starts at the top, so it must start expanded; inheriting a collapsed bar reads as broken.
	afterNavigate(({ shallow, type }) => {
		if (shallow && type === 'goto') return;

		phase = initialScrollPhase;
		compact = false;
	});

	// iOS floats a fixed bottom element above the soft keyboard, covering the field being typed into.
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

	// `--tab-bar-space` (page padding) never follows the collapsed height: shrinking it mid-scroll moves
	// scrollY, which feeds the compaction fold and the two oscillate. `--tab-bar-live` tracks the live
	// height for the fixed overlays above the bar, which costs no reflow.
	let card = $state<HTMLElement | null>(null);
	$effect(() => {
		const el = card;
		if (!el) return;
		const publish = (height: number) => {
			const space = `calc(${height}px + max(0.75rem, env(safe-area-inset-bottom)))`;
			document.documentElement.style.setProperty('--tab-bar-live', space);
			if (!compact) document.documentElement.style.setProperty('--tab-bar-space', space);
		};
		// A ResizeObserver's first callback isn't guaranteed to arrive, and the API may not exist.
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

<nav
	aria-label="Primary"
	data-sveltekit-preload-data="tap"
	class="pointer-events-none fixed inset-x-0 bottom-0 z-40 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] transition-[transform,opacity] duration-200 motion-reduce:transition-none {keyboard
		? 'translate-y-full opacity-0'
		: ''}"
>
	<ul
		bind:this={card}
		class="glass pointer-events-auto mx-auto flex w-full max-w-md items-stretch justify-around gap-1 rounded-full border border-border p-1.5 shadow-[0_4px_12px_rgb(0_0_0/0.1)] sm:max-w-fit sm:gap-0.5"
	>
		{#each navTabs as def (def.id)}
			{@const Icon = ICONS[def.id]}
			{@const isSelected = selected === def.id}
			<li class="flex min-w-0 flex-1 sm:flex-none">
				<!-- eslint-disable svelte/no-navigation-without-resolve -- a remembered destination
				carries a query string, which drops resolve()'s branded type; `tabHref` has already
				validated the value as an own-tab, same-origin path. -->
				<a
					href={tabs.href(def.id)}
					data-sveltekit-noscroll
					aria-current={current === def.id ? 'page' : undefined}
					onclick={(event) => onTabClick(event, def)}
					class="flex min-w-0 flex-1 touch-manipulation flex-col items-center justify-center rounded-full px-1 py-2 transition-[gap] duration-200 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none sm:flex-row sm:gap-2 sm:px-4 sm:py-2.5 {isSelected
						? 'text-primary sm:bg-primary/10'
						: 'text-muted-foreground sm:hover:bg-accent sm:hover:text-foreground'}"
				>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
					<span
						class="relative flex h-8 w-14 shrink-0 items-center justify-center sm:h-auto sm:w-auto"
					>
						<span
							class="absolute inset-0 rounded-full bg-primary/12 transition-opacity duration-200 motion-reduce:transition-none sm:hidden {isSelected
								? 'opacity-100'
								: 'opacity-0'}"
						></span>
						<Icon class="relative size-5" />
					</span>
					<span
						class="grid min-h-0 transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none sm:grid-rows-[1fr]! sm:opacity-100! {compact
							? 'grid-rows-[0fr] opacity-0'
							: 'grid-rows-[1fr] opacity-100'}"
					>
						<span
							class="overflow-hidden text-[0.6875rem] leading-[1.35] font-medium sm:text-sm {isSelected
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
