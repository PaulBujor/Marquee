<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { Button, type ButtonSize } from '$lib/components/ui/button';
	import { shareAndWarm, type ShareWarmTarget } from '$lib/share';
	import ShareIcon from '@lucide/svelte/icons/share-2';

	interface Props {
		/** The path to share — the call site builds it with `resolve()`. */
		path: string;
		title: string;
		/** The thing this link points at, so its preview is stored before the sheet opens. */
		warm?: ShareWarmTarget;
		label?: string;
		size?: ButtonSize;
		variant?: 'ghost' | 'outline';
		class?: string;
	}
	let {
		path,
		title,
		warm,
		label = 'Share',
		size = 'icon',
		variant = 'ghost',
		class: className = ''
	}: Props = $props();

	let busy = $state(false);

	async function onShare() {
		if (busy) return;
		busy = true;
		try {
			const url = new URL(path, window.location.origin).toString();
			// The warm runs alongside the sheet so the tap answers immediately; its outcome still picks the
			// toast, because a share whose preview never stored must not look like a clean one.
			const { outcome, warmed } = await shareAndWarm({ title, url }, warm);
			if (outcome === 'failed') toast.error("Couldn't share that link");
			else if (warmed === 'failed') toast.warning('Link shared, but no preview was stored');
			else if (warmed === 'timeout') toast.info('Link shared — the preview may still be storing');
			else if (outcome === 'copied') toast.success('Link copied');
		} finally {
			busy = false;
		}
	}
</script>

<Button
	{variant}
	{size}
	shape="round"
	class={className}
	disabled={busy}
	onclick={onShare}
	aria-label={label}
	title={label}
>
	<ShareIcon class="size-5" />
</Button>
