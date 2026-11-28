<script lang="ts">
	/**
	 * The rewind dial: half a clock face, "now" at noon, the positions running counter-clockwise
	 * down to 6 o'clock. Drag the hand, scroll over it, or step it with the arrow keys.
	 *
	 * It is deliberately dumb about what a position means — it reports a fraction (0 = now, 1 = the
	 * far end) plus one-detent steps, so the same dial serves both the event and the time view.
	 */
	import { prefersReducedMotion } from 'svelte/motion';

	interface Props {
		/** 0 = now, 1 = the far end of the range. */
		progress: number;
		/** Spoken value: "1 day ago", "12 events back". */
		valueLabel: string;
		/** Ticks with words; without them the dial shows only its two ends. */
		labels?: readonly string[];
		/** The pointer landed on a position (0..1). `fine` = Shift was held. */
		onseek: (progress: number, fine: boolean) => void;
		/** One detent: −1 towards now, 1 further back. */
		ondetent: (direction: 1 | -1, fine: boolean) => void;
	}
	let { progress, valueLabel, labels, onseek, ondetent }: Props = $props();

	/** Degrees the gauge spans, from 12 o'clock round to 6 o'clock. */
	const SWEEP = 180;
	const CENTRE = 120;
	const RADIUS = 84;
	const LABEL_RADIUS = 106;
	const ARC_TICKS = 9;

	const reduced = $derived(prefersReducedMotion.current);
	const ticks = $derived(
		labels && labels.length > 1
			? labels.map((label, i) => ({ label, progress: i / (labels.length - 1) }))
			: []
	);

	/** -90° is 12 o'clock; moving back turns the hand counter-clockwise. */
	function angleAt(position: number): number {
		return -90 - position * SWEEP;
	}

	function pointAt(position: number, radius: number): { x: number; y: number } {
		const radians = (angleAt(position) * Math.PI) / 180;
		return {
			x: CENTRE + radius * Math.cos(radians),
			y: CENTRE + radius * Math.sin(radians)
		};
	}

	const arcStart = pointAt(0, RADIUS);
	const arcEnd = pointAt(1, RADIUS);
	const knob = $derived(pointAt(Math.max(0, Math.min(1, progress)), RADIUS));

	let svg = $state<SVGSVGElement | null>(null);
	let dragging = $state(false);
	let wheelDelta = 0;

	/** Angle under the pointer, projected onto the gauge's half of the circle. */
	function progressFromPointer(event: PointerEvent): number {
		const el = svg;
		if (!el) return progress;
		const rect = el.getBoundingClientRect();
		const dx = event.clientX - (rect.left + rect.width / 2);
		const dy = event.clientY - (rect.top + rect.height / 2);
		const degrees = (Math.atan2(dy, dx) * 180) / Math.PI; // 0° = 3 o'clock, positive = clockwise
		// The right half has no detents: it clamps to whichever end of the gauge is nearest.
		const sweep =
			degrees >= -90 && degrees < 90 ? 0 : -90 - (degrees > 90 ? degrees - 360 : degrees);
		return Math.min(SWEEP, Math.max(0, sweep)) / SWEEP;
	}

	function onPointerDown(event: PointerEvent): void {
		dragging = true;
		svg?.setPointerCapture(event.pointerId);
		onseek(progressFromPointer(event), event.shiftKey);
	}

	function onPointerMove(event: PointerEvent): void {
		if (dragging) onseek(progressFromPointer(event), event.shiftKey);
	}

	function onPointerUp(event: PointerEvent): void {
		dragging = false;
		// A `pointercancel` releases the capture itself; releasing it again throws.
		if (svg?.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
	}

	/** Trackpads fire many small deltas, so accumulate into one detent per ~40px of intent. */
	function onWheel(event: WheelEvent): void {
		event.preventDefault();
		wheelDelta = Math.max(-120, Math.min(120, wheelDelta + event.deltaY));
		if (Math.abs(wheelDelta) < 40) return;
		// Scrolling up (a negative delta) winds the dial backwards.
		ondetent(wheelDelta > 0 ? -1 : 1, event.shiftKey);
		wheelDelta = 0;
	}

	function onKeydown(event: KeyboardEvent): void {
		const fine = event.shiftKey;
		switch (event.key) {
			case 'ArrowLeft':
			case 'ArrowUp': // back in time
				event.preventDefault();
				ondetent(1, fine);
				return;
			case 'ArrowRight':
			case 'ArrowDown': // towards now
				event.preventDefault();
				ondetent(-1, fine);
				return;
			case 'Home':
				event.preventDefault();
				onseek(0, fine);
				return;
			case 'End':
				event.preventDefault();
				onseek(1, fine);
				return;
		}
	}
</script>

<div
	class="relative mx-auto w-full max-w-70 touch-none select-none"
	role="slider"
	tabindex="0"
	aria-label="Rewind the library"
	aria-valuemin={0}
	aria-valuemax={1}
	aria-valuenow={Math.round(Math.max(0, Math.min(1, progress)) * 100)}
	aria-valuetext={valueLabel}
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
		<!-- The arc the detents sit on -->
		<path
			d={`M ${arcStart.x} ${arcStart.y} A ${RADIUS} ${RADIUS} 0 0 0 ${arcEnd.x} ${arcEnd.y}`}
			class="fill-none stroke-border"
			stroke-width="2"
			stroke-linecap="round"
		/>
		<!-- Plain detent marks along the arc, so the gauge reads as a scale even without labels -->
		{#each Array.from({ length: ARC_TICKS }, (_, i) => i / (ARC_TICKS - 1)) as position (position)}
			{@const dot = pointAt(position, RADIUS)}
			<circle cx={dot.x} cy={dot.y} r={1.5} class="fill-muted-foreground" />
		{/each}
		{#each ticks as tick (tick.label)}
			{@const label = pointAt(tick.progress, LABEL_RADIUS)}
			<text
				x={label.x}
				y={label.y}
				text-anchor="middle"
				dominant-baseline="middle"
				class="fill-muted-foreground text-[10px]"
			>
				{tick.label}
			</text>
		{/each}
		<!-- The two ends are always named; in a long log "start" is as useful as "now". -->
		{#if !labels}
			{@const top = pointAt(0, LABEL_RADIUS)}
			{@const bottom = pointAt(1, LABEL_RADIUS)}
			<text
				x={top.x}
				y={top.y}
				text-anchor="middle"
				dominant-baseline="middle"
				class="fill-muted-foreground text-[10px]"
			>
				now
			</text>
			<text
				x={bottom.x}
				y={bottom.y}
				text-anchor="middle"
				dominant-baseline="middle"
				class="fill-muted-foreground text-[10px]"
			>
				start
			</text>
		{/if}
		<!-- Hand, with a transition so a detent settles rather than jumps -->
		<g
			style:transform={`rotate(${angleAt(Math.max(0, Math.min(1, progress))) + 90}deg)`}
			style:transform-origin={`${CENTRE}px ${CENTRE}px`}
			style:transition={reduced ? 'none' : 'transform 320ms cubic-bezier(.22,1,.36,1)'}
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
