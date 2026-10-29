<script lang="ts">
	// The public pages' only call to action. Marquee accounts start `pending`, so this has to serve
	// an existing user and a stranger alike: the sign-in page is also where the waitlist lives.
	import { Button } from '$lib/components/ui/button';

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
