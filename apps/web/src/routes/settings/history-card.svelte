<script lang="ts">
	import { resolve } from '$app/paths';
	import { buttonVariants } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Time travel</Card.Title>
		<Card.Description>
			Scrub back through the library and put it back the way it was — a rewind, not a reset.
		</Card.Description>
	</Card.Header>
	<Card.Content>
		<a href={resolve('/history')} class={buttonVariants({ variant: 'outline' })}
			>Rewind the library</a
		>
	</Card.Content>
</Card.Root>
