<script lang="ts">
	import { resolve } from '$app/paths';
	import * as Card from '#lib/components/ui/card/index.js';
</script>

<Card.Root data-spec-ref="settings-admin-section">
	<Card.Header>
		<Card.Title>Admin</Card.Title>
	</Card.Header>
	<Card.Content class="flex flex-col gap-3">
		<p class="text-sm text-muted-foreground">Manage accounts and cached media.</p>
		<a href={resolve('/admin')} class="self-start text-sm underline underline-offset-2"
			>Open admin</a
		>
	</Card.Content>
</Card.Root>
