<script lang="ts">
	import * as Card from '$lib/components/ui/card';
</script>

<Card.Root data-spec-ref="settings-credits-section">
	<Card.Header>
		<Card.Title>Credits</Card.Title>
	</Card.Header>
	<Card.Content class="flex flex-col gap-3">
		<img src="/tmdb.svg" alt="The Movie Database (TMDB)" class="h-4 w-auto self-start" />
		<p class="text-sm text-muted-foreground">
			This product uses the TMDB API but is not endorsed or certified by TMDB.
		</p>
	</Card.Content>
</Card.Root>
