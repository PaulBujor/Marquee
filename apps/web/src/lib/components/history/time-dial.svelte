<script lang="ts">
	/**
	 * The rewind dial: half a clock face, "now" at noon, the stops running counter-clockwise down
	 * to 6 o'clock. Drag the hand, scroll over it, or step it with the arrow keys.
	 */
	import { prefersReducedMotion } from 'svelte/motion';
	import { REWIND_STOPS } from '#lib/sync/history.js';

	interface Props {
		/** Selected stop; 0 is now. */
		index: number;
		onchange: (index: number) => void;
	}
	let { index, onchange }: Props = $props();

	const LAST = REWIND_STOPS.length - 1;
	/** Degrees the gauge spans, from 12 o'clock round to 6 o'clock. */
	const SWEEP = 180;
	const CENTRE = 120;
	const RADIUS = 84;
	const LABEL_RADIUS = 106;

	const reduced = $derived(prefersReducedMotion.current);

	/** -90° is 12 o'clock; each stop turns the hand further counter-clockwise. */
	function angleOf(stop: number): number {
		return -90 - (stop * SWEEP) / LAST;
	}

	function pointOn(stop: number, radius: number): { x: number; y: number } {
		const radians = (angleOf(stop) * Math.PI) / 180;
		return {
			x: CENTRE + radius * Math.cos(radians),
			y: CENTRE + radius * Math.sin(radians)
		};
	}

	const ticks = REWIND_STOPS.map((stop, i) => ({ ...stop, index: i, point: pointOn(i, RADIUS) }));
	const arcStart = pointOn(0, RADIUS);
	const arcEnd = pointOn(LAST, RADIUS);
	const knob = $derived(pointOn(index, RADIUS));

	let svg = $state<SVGSVGElement | null>(null);
	let dragging = $state(false);
	let wheelDelta = 0;

	function select(stop: number): void {
		const next = Math.max(0, Math.min(LAST, stop));
		if (next !== index) onchange(next);
	}

	/** Angle under the pointer, projected onto the gauge's half of the circle. */
	function stopFromPointer(event: PointerEvent): number {
		const el = svg;
		if (!el) return index;
		const rect = el.getBoundingClientRect();
		const dx = event.clientX - (rect.left + rect.width / 2);
		const dy = event.clientY - (rect.top + rect.height / 2);
		const degrees = (Math.atan2(dy, dx) * 180) / Math.PI; // 0° = 3 o'clock, positive = clockwise
		// The right half has no stops: it clamps to whichever end of the gauge is nearest.
		const sweep =
			degrees >= -90 && degrees < 90 ? 0 : -90 - (degrees > 90 ? degrees - 360 : degrees);
		return Math.round((Math.min(SWEEP, Math.max(0, sweep)) / SWEEP) * LAST);
	}

	function onPointerDown(event: PointerEvent): void {
		dragging = true;
		svg?.setPointerCapture(event.pointerId);
		select(stopFromPointer(event));
	}

	function onPointerMove(event: PointerEvent): void {
		if (dragging) select(stopFromPointer(event));
	}

	function onPointerUp(event: PointerEvent): void {
		dragging = false;
		svg?.releasePointerCapture(event.pointerId);
	}

	/** Trackpads fire many small deltas, so accumulate into one stop per ~40px of intent. */
	function onWheel(event: WheelEvent): void {
		event.preventDefault();
		wheelDelta = Math.max(-120, Math.min(120, wheelDelta + event.deltaY));
		if (Math.abs(wheelDelta) < 40) return;
		// Scrolling up (a negative delta) winds the dial backwards.
		select(index + (wheelDelta > 0 ? -1 : 1));
		wheelDelta = 0;
	}

	function onKeydown(event: KeyboardEvent): void {
		const steps: Record<string, number> = {
			ArrowLeft: 1,
			ArrowUp: 1, // back in time
			ArrowRight: -1,
			ArrowDown: -1, // towards now
			Home: -LAST,
			End: LAST
		};
		const step = steps[event.key];
		if (step === undefined) return;
		event.preventDefault();
		select(event.key === 'Home' ? 0 : event.key === 'End' ? LAST : index + step);
	}
</script>

<div
	class="relative mx-auto w-full max-w-70 touch-none select-none"
	role="slider"
	tabindex="0"
	aria-label="Rewind the library"
	aria-valuemin={0}
	aria-valuemax={LAST}
	aria-valuenow={index}
	aria-valuetext={REWIND_STOPS[index].label}
	class:cursor-grabbing={dragging}
	class:cursor-grab={!dragging}
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	onpointercancel={onPointerUp}
	onwheel={onWheel}
	onkeydown={onKeydown}
>
	<svg bind:this={svg} viewBox="0 0 240 240" class="w-full overflow-visible" aria-hidden="true">
		<!-- Face -->
		<circle
			cx={CENTRE}
			cy={CENTRE}
			r={RADIUS + 16}
			class="fill-card stroke-border"
			stroke-width="1"
		/>
		<!-- The arc the stops sit on -->
		<path
			d={`M ${arcStart.x} ${arcStart.y} A ${RADIUS} ${RADIUS} 0 0 0 ${arcEnd.x} ${arcEnd.y}`}
			class="fill-none stroke-border"
			stroke-width="2"
			stroke-linecap="round"
		/>
		<!-- Ticks and their labels -->
		{#each ticks as tick (tick.label)}
			{@const label = pointOn(tick.index, LABEL_RADIUS)}
			<circle
				cx={tick.point.x}
				cy={tick.point.y}
				r={tick.index === index ? 0 : 2}
				class="fill-muted-foreground"
			/>
			<text
				x={label.x}
				y={label.y}
				text-anchor="middle"
				dominant-baseline="middle"
				class={tick.index === index
					? 'fill-primary text-[11px] font-semibold'
					: 'fill-muted-foreground text-[10px]'}
			>
				{tick.label}
			</text>
		{/each}
		<!-- Hand, with a transition so a snapped stop settles rather than jumps -->
		<g
			style:transform={`rotate(${angleOf(index) + 90}deg)`}
			style:transform-origin={`${CENTRE}px ${CENTRE}px`}
			style:transition={reduced ? 'none' : 'transform 420ms cubic-bezier(.22,1,.36,1)'}
		>
			<line
				x1={CENTRE}
				y1={CENTRE}
				x2={CENTRE}
				y2={CENTRE - (RADIUS - 22)}
				class="stroke-primary"
				stroke-width="3"
				stroke-linecap="round"
			/>
			<circle cx={CENTRE} cy={CENTRE} r={5} class="fill-primary" />
		</g>
		<circle cx={knob.x} cy={knob.y} r={7} class="fill-primary" />
	</svg>
</div>
