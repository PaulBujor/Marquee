<script lang="ts">
	/**
	 * The rewind tape: a horizontal strip of event tiles that scrolls under a fixed pointer. Drag it,
	 * fling it, wheel it, or step it with the keyboard; the event under the pointer is the selection.
	 *
	 * The strip is virtualised — only the tiles the viewport covers are in the DOM — so the log can
	 * hold thousands of events without the page holding thousands of nodes. Mid-fling the tiles
	 * become placeholders and only every settled crossing is reported to the parent, which keeps the
	 * state replay (and the haptics) off the frame budget.
	 */
	import type { Snippet } from 'svelte';
	import { onDestroy } from 'svelte';
	import { prefersReducedMotion } from 'svelte/motion';
	import { haptics } from '#lib/client/history/haptics.svelte.js';
	import {
		FLING_DECAY,
		FLING_REST_SPEED,
		clampIndex,
		offsetForIndex,
		settleIndex,
		tilesRenderable,
		visibleRange
	} from '#lib/sync/tape.js';

	interface Props {
		/** Events in the log; the index runs `0..length`, where `length` is now. */
		length: number;
		/** The settled event index. */
		index: number;
		/** Px per event. */
		pitch: number;
		/** Spoken position for assistive tech. */
		valueLabel: string;
		/** One tile's contents: the index, and whether it's a mid-fling placeholder. */
		tile: Snippet<[number, boolean]>;
	}
	let { length, index = $bindable(0), pitch, valueLabel, tile }: Props = $props();

	const SPEED_SMOOTHING = 0.3;
	const SETTLE_MS = 220;
	const WHEEL_SETTLE_MS = 140;

	let position = $state(index);
	let width = $state(0);
	let speed = $state(0);
	let dragging = $state(false);
	let box = $state<HTMLDivElement | null>(null);

	let frame = 0;
	let wheelTimer: ReturnType<typeof setTimeout> | null = null;
	let startX = 0;
	let startPosition = 0;
	let lastSample = { at: 0, position: 0 };

	const reduced = $derived(prefersReducedMotion.current);
	const ghost = $derived(!tilesRenderable(speed));
	const range = $derived(visibleRange(position, pitch, width, length));
	const tiles = $derived(
		Array.from({ length: range.end - range.start + 1 }, (_, i) => range.start + i)
	);

	// Follow an index set from outside the tape (a day chip, a filter jump, Home).
	$effect(() => {
		const external = index;
		if (dragging || frame !== 0) return;
		if (Math.abs(position - external) > 0.5) position = external;
	});

	$effect(() => {
		const el = box;
		if (!el) return;
		const measure = () => (width = el.clientWidth);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	});

	onDestroy(() => {
		if (frame) cancelAnimationFrame(frame);
		if (wheelTimer) clearTimeout(wheelTimer);
	});

	function stopMotion(): void {
		if (frame) cancelAnimationFrame(frame);
		frame = 0;
	}

	/**
	 * Report the settled event to the parent — the crossing, not every pixel. Skipped mid-fling,
	 * where the tape is moving too fast for the answer to mean anything yet.
	 */
	function commit(force = false): void {
		const next = settleIndex(position, length);
		if (next === index) return;
		if (!force && !tilesRenderable(speed)) return;
		index = next;
		haptics.tick();
	}

	/** Ease to a whole-event target — used for a fling's landing, a key step and a wheel release. */
	function settleTo(target: number): void {
		stopMotion();
		const to = settleIndex(target, length);
		if (reduced || Math.abs(to - position) < 0.01) {
			position = to;
			speed = 0;
			commit(true);
			return;
		}
		const from = position;
		const started = performance.now();
		const step = (now: number) => {
			const t = Math.min(1, (now - started) / SETTLE_MS);
			position = from + (to - from) * (1 - Math.pow(1 - t, 3));
			if (t < 1) {
				frame = requestAnimationFrame(step);
				return;
			}
			frame = 0;
			position = to;
			speed = 0;
			commit(true);
		};
		frame = requestAnimationFrame(step);
	}

	/** Exponential decay until the fling is too slow to read, then land on a whole event. */
	function fling(velocity: number): void {
		stopMotion();
		let speedNow = velocity;
		const step = () => {
			speedNow *= FLING_DECAY;
			position = clampIndex(position + speedNow / 60, length);
			speed = Math.abs(speedNow);
			if (Math.abs(speedNow) < FLING_REST_SPEED) {
				frame = 0;
				settleTo(position);
				return;
			}
			frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
	}

	function onPointerDown(event: PointerEvent): void {
		if (event.button !== 0) return;
		box?.setPointerCapture(event.pointerId);
		stopMotion();
		if (wheelTimer) clearTimeout(wheelTimer);
		wheelTimer = null;
		dragging = true;
		speed = 0;
		startX = event.clientX;
		startPosition = position;
		lastSample = { at: event.timeStamp, position };
	}

	function onPointerMove(event: PointerEvent): void {
		if (!dragging) return;
		const next = clampIndex(startPosition - (event.clientX - startX) / pitch, length);
		const elapsed = event.timeStamp - lastSample.at;
		if (elapsed > 0) {
			const instant = (next - lastSample.position) / (elapsed / 1000);
			speed = SPEED_SMOOTHING * instant + (1 - SPEED_SMOOTHING) * speed;
			lastSample = { at: event.timeStamp, position: next };
		}
		position = next;
		commit();
	}

	function onPointerUp(event: PointerEvent): void {
		if (!dragging) return;
		dragging = false;
		if (box?.hasPointerCapture(event.pointerId)) box.releasePointerCapture(event.pointerId);
		if (reduced || Math.abs(speed) < FLING_REST_SPEED) settleTo(position);
		else fling(speed);
	}

	/** Trackpads fire many small deltas: move freely, then settle once the hand stops. */
	function onWheel(event: WheelEvent): void {
		event.preventDefault();
		stopMotion();
		position = clampIndex(position + (event.deltaY + event.deltaX) / pitch, length);
		speed = 0;
		commit();
		if (wheelTimer) clearTimeout(wheelTimer);
		wheelTimer = setTimeout(() => {
			wheelTimer = null;
			settleTo(position);
		}, WHEEL_SETTLE_MS);
	}

	function moveTo(next: number): void {
		const to = settleIndex(next, length);
		if (to === index && Math.abs(position - to) < 0.01) return;
		index = to;
		haptics.tick();
		settleTo(to);
	}

	function onKeydown(event: KeyboardEvent): void {
		switch (event.key) {
			case 'ArrowLeft':
				event.preventDefault();
				moveTo(index - 1);
				return;
			case 'ArrowRight':
				event.preventDefault();
				moveTo(index + 1);
				return;
			case 'PageUp':
				event.preventDefault();
				moveTo(index + 10);
				return;
			case 'PageDown':
				event.preventDefault();
				moveTo(index - 10);
				return;
			case 'Home':
				event.preventDefault();
				moveTo(length);
				return;
			case 'End':
				event.preventDefault();
				moveTo(0);
				return;
		}
	}
</script>

<div
	bind:this={box}
	class="relative h-24 touch-pan-y overflow-hidden rounded-lg border bg-secondary/40 select-none"
	class:cursor-grabbing={dragging}
	class:cursor-grab={!dragging}
	role="slider"
	tabindex="0"
	aria-label="Rewind the log"
	aria-valuemin={0}
	aria-valuemax={length}
	aria-valuenow={index}
	aria-valuetext={valueLabel}
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	onpointercancel={onPointerUp}
	onwheel={onWheel}
	onkeydown={onKeydown}
>
	<ul
		class="absolute top-0 left-0 flex h-full will-change-transform"
		style:transform={`translate3d(${width / 2 - offsetForIndex(position, pitch) + range.start * pitch}px, 0, 0)`}
	>
		{#each tiles as step (step)}
			<li class="h-full shrink-0 px-px" style:width={`${pitch}px`}>
				{@render tile(step, ghost)}
			</li>
		{/each}
	</ul>

	<!-- The pointer: the tile under this line is the selection. -->
	<div
		class="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-primary"
	></div>
</div>
