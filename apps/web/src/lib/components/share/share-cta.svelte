<script lang="ts">
	// Marquee accounts start `pending`, so this serves an existing user and a stranger alike.
	import { Button } from '#lib/components/ui/button/index.js';

	interface Props {
		href: string;
	}
	let { href }: Props = $props();
</script>

<div class="flex flex-col items-center gap-2">
	<Button {href}>Sign in to track it</Button>
	<p class="max-w-prose text-center text-xs text-muted-foreground">
		Marquee is invite-only for now — signing in also lets you join the waitlist.
	</p>
</div>
