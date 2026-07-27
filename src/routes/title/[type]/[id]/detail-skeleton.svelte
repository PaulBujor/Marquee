<script lang="ts">
	import { Skeleton } from '$lib/components/ui/skeleton';

	// Placeholder shown while the title detail streams in — mirrors the real layout (backdrop, poster
	// + title, meta row, action row, a few detail lines) so the page doesn't jump when content lands.
</script>

<main class="mx-auto w-full max-w-2xl" aria-busy="true" aria-label="Loading title">
	<Skeleton class="aspect-video w-full rounded-none" />
	<div class="-mt-14 flex flex-col gap-4 px-5 pb-10">
		<div class="flex items-end gap-4">
			<Skeleton class="aspect-[2/3] w-24 shrink-0 rounded-[14px] ring-4 ring-background" />
			<div class="flex min-w-0 flex-1 flex-col gap-2 pb-1">
				<Skeleton class="h-7 w-3/4" />
				<Skeleton class="h-5 w-24 rounded-full" />
			</div>
		</div>
		<div class="flex items-center gap-3">
			<Skeleton class="h-4 w-16" />
			<Skeleton class="h-4 w-20" />
			<Skeleton class="h-5 w-16 rounded-full" />
		</div>
		<Skeleton class="h-9 w-56 rounded-md" />
		<div class="flex flex-col gap-2">
			<Skeleton class="h-4 w-full" />
			<Skeleton class="h-4 w-full" />
			<Skeleton class="h-4 w-2/3" />
		</div>
	</div>
</main>
