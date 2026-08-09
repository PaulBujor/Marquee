<script lang="ts">
	// TEMPORARY diagnostic — remove before merge.
	//
	// The tab bar starts too high in the installed PWA and drops into place on the first scroll,
	// which means the viewport it is positioned against is wrong until iOS settles it. Reading that
	// requires a console, which needs a Mac. So the numbers are rendered on screen instead, on the
	// dashboard (navigating anywhere might itself trigger the relayout and hide the evidence) and
	// frozen at mount so they survive any interaction.
	import { onMount } from 'svelte';

	interface Sample {
		layout: number;
		visual: number;
		inner: number;
		screen: number;
		safeTop: string;
		safeBottom: string;
		shift: string;
		scrollY: number;
	}

	function sample(): Sample {
		const vv = window.visualViewport;
		const style = getComputedStyle(document.documentElement);
		const probe = document.createElement('div');
		probe.style.cssText =
			'position:fixed;top:env(safe-area-inset-top);bottom:env(safe-area-inset-bottom);visibility:hidden';
		document.body.appendChild(probe);
		const probeStyle = getComputedStyle(probe);
		const safeTop = probeStyle.top;
		const safeBottom = probeStyle.bottom;
		probe.remove();
		return {
			layout: document.documentElement.clientHeight,
			visual: vv ? Math.round(vv.height + vv.offsetTop) : -1,
			inner: window.innerHeight,
			screen: window.screen.height,
			safeTop,
			safeBottom,
			shift: style.getPropertyValue('--viewport-shift').trim() || '(unset)',
			scrollY: Math.round(window.scrollY)
		};
	}

	let atMount = $state<Sample | null>(null);
	let afterSettle = $state<Sample | null>(null);
	let live = $state<Sample | null>(null);
	let standalone = $state(false);

	onMount(() => {
		standalone = window.matchMedia('(display-mode: standalone)').matches;
		atMount = sample();
		setTimeout(() => (afterSettle = sample()), 1500);
		const tick = setInterval(() => (live = sample()), 500);
		return () => clearInterval(tick);
	});

	const row = (s: Sample) =>
		`layout ${s.layout} · visual ${s.visual} · inner ${s.inner} · screen ${s.screen} · safe ${s.safeTop}/${s.safeBottom} · shift ${s.shift} · scrollY ${s.scrollY}`;
</script>

<div
	class="mb-4 rounded-sm border border-border bg-secondary p-3 font-mono text-[0.65rem] leading-5"
>
	<div class="font-bold">viewport debug (temporary) · standalone: {standalone}</div>
	{#if atMount}<div>at mount: {row(atMount)}</div>{/if}
	{#if afterSettle}<div>+1.5s: {row(afterSettle)}</div>{/if}
	{#if live}<div>live: {row(live)}</div>{/if}
</div>
