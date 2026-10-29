<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { Button, type ButtonSize } from '$lib/components/ui/button';
	import { shareLink } from '$lib/share';
	import ShareIcon from '@lucide/svelte/icons/share-2';

	interface Props {
		/** The path to share — the call site builds it with `resolve()`. */
		path: string;
		title: string;
		label?: string;
		size?: ButtonSize;
		variant?: 'ghost' | 'outline';
		class?: string;
	}
	let {
		path,
		title,
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
			const outcome = await shareLink({ title, url });
			if (outcome === 'copied') toast.success('Link copied');
			else if (outcome === 'failed') toast.error("Couldn't share that link");
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
