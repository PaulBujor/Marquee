// Shared driver for the app's persistent "prompt" toasts (install, update, notification opt-in).
// Turns a reactive predicate into a single fixed-id Sonner toast that shows while the predicate
// holds and is dismissed when it clears. Message/action are read reactively, so flipping a
// `busy`-style flag re-fires the same-id toast in place (e.g. "Enable" -> "Enabling…").

import { toast } from 'svelte-sonner';

interface PromptToastOptions {
	/** Stable toast id so only one instance ever exists and re-fires update it in place. */
	id: string;
	/** Reactive predicate — the toast is shown while this is true. */
	when: () => boolean;
	/** Reactive message. */
	message: () => string;
	/** Reactive action button (omit for instructional toasts with no action). */
	action?: () => { label: string; onClick: () => void } | undefined;
	/** Called when the user closes/swipes the toast — e.g. persist a "don't ask again" flag. */
	onDismiss?: () => void;
}

/** Call once during a component's init; the effect is bound to that component's lifecycle. */
export function promptToast(opts: PromptToastOptions): void {
	const { onDismiss } = opts;
	$effect(() => {
		if (opts.when()) {
			toast(opts.message(), {
				id: opts.id,
				duration: Infinity,
				closeButton: true,
				action: opts.action?.(),
				// Sonner fires `onDismiss` for programmatic dismisses too, so gate on the predicate
				// still holding — that's a genuine user close, not us tearing the toast down.
				onDismiss: onDismiss ? () => opts.when() && onDismiss() : undefined
			});
		} else {
			toast.dismiss(opts.id);
		}
	});
}
