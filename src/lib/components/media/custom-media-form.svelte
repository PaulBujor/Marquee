<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import * as ToggleGroup from '$lib/components/ui/toggle-group';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import {
		CUSTOM_MAX_EPISODES_PER_SEASON,
		CUSTOM_MAX_EPISODES_TOTAL,
		CUSTOM_MAX_SEASONS,
		CUSTOM_MAX_YEAR,
		CUSTOM_MIN_YEAR,
		CUSTOM_OVERVIEW_MAX,
		CUSTOM_TITLE_MAX,
		customMediaInputSchema,
		totalEpisodes,
		type CustomMediaInput,
		type CustomSeasonInput
	} from '$lib/validation/custom-media';

	/**
	 * Create or edit a user-authored entry. Not a `<form method="POST">`: authoring has to work
	 * offline, where an action can't run, so the parent takes the validated input and writes it
	 * through the local store. Validation here is the immediate-feedback half — the media channel
	 * re-checks the same schema server-side.
	 */
	interface Props {
		open?: boolean;
		/** Present when editing; absent when creating. */
		initial?: CustomMediaInput;
		/** Prefills a new entry from whatever the user was searching for. */
		initialTitle?: string;
		initialType?: 'movie' | 'show';
		busy?: boolean;
		onsubmit: (input: CustomMediaInput) => void;
	}
	let {
		open = $bindable(false),
		initial,
		initialTitle = '',
		initialType = 'movie',
		busy = false,
		onsubmit
	}: Props = $props();

	const editing = $derived(initial !== undefined);

	let title = $state('');
	let type = $state<'movie' | 'show'>('movie');
	// Year and episode counts are held as strings: an `<input type="number">` binds to `''` while
	// being cleared, and coercing mid-edit would fight the user's typing.
	let year = $state('');
	let overview = $state('');
	let seasons = $state<{ seasonNumber: number; episodes: string }[]>([]);
	let showErrors = $state(false);

	// Reseed whenever the dialog opens, so reopening never shows the previous entry's values.
	let seeded = false;
	$effect(() => {
		if (!open) {
			seeded = false;
			return;
		}
		if (seeded) return;
		seeded = true;
		showErrors = false;
		title = initial?.title ?? initialTitle;
		type = initial?.type ?? initialType;
		year = initial?.year != null ? String(initial.year) : '';
		overview = initial?.overview ?? '';
		seasons = (initial?.seasons ?? []).map((s) => ({
			seasonNumber: s.seasonNumber,
			episodes: String(s.episodeCount)
		}));
	});

	/** The season rows as the schema wants them; a blank or unparseable count reads as zero. */
	const seasonInput = $derived<CustomSeasonInput[]>(
		seasons.map((s) => ({
			seasonNumber: s.seasonNumber,
			episodeCount: Number.isInteger(Number(s.episodes)) ? Number(s.episodes) : -1
		}))
	);

	const candidate = $derived<CustomMediaInput>({
		title,
		type,
		year: year.trim() === '' ? null : Number(year),
		overview,
		seasons: type === 'show' ? seasonInput : []
	});

	const parsed = $derived(customMediaInputSchema.safeParse(candidate));
	const episodeTotal = $derived(totalEpisodes(seasonInput));

	/** First message for a field, shown only once the user has tried to submit. */
	function errorFor(field: 'title' | 'year' | 'seasons'): string | null {
		if (!showErrors || parsed.success) return null;
		const issue = parsed.error.issues.find((i) => i.path[0] === field);
		return issue?.message ?? null;
	}
	const titleError = $derived(errorFor('title'));
	const yearError = $derived(errorFor('year'));
	const seasonsError = $derived(errorFor('seasons'));

	function addSeason() {
		if (seasons.length >= CUSTOM_MAX_SEASONS) return;
		const next = seasons.reduce((max, s) => Math.max(max, s.seasonNumber), 0) + 1;
		seasons = [...seasons, { seasonNumber: next, episodes: '' }];
	}

	function removeSeason(seasonNumber: number) {
		seasons = seasons.filter((s) => s.seasonNumber !== seasonNumber);
	}

	function submit(event: SubmitEvent) {
		event.preventDefault();
		showErrors = true;
		if (!parsed.success || busy) return;
		onsubmit(parsed.data);
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="flex max-h-[85svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
		<Dialog.Header class="border-b border-border p-4">
			<Dialog.Title class="text-base">
				{editing ? 'Edit entry' : 'Add a title manually'}
			</Dialog.Title>
			<Dialog.Description class="text-xs">
				{editing
					? 'Your own details for this entry. Nobody else can see them.'
					: "For titles the database doesn't have. Yours alone, and you can match it to a database entry later."}
			</Dialog.Description>
		</Dialog.Header>

		<form onsubmit={submit} class="flex min-h-0 flex-1 flex-col">
			<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
				<div class="flex flex-col gap-1.5">
					<label for="custom-title" class="text-sm font-medium">Title</label>
					<Input
						id="custom-title"
						bind:value={title}
						required
						maxlength={CUSTOM_TITLE_MAX}
						autocomplete="off"
						aria-invalid={titleError ? 'true' : undefined}
						aria-describedby={titleError ? 'custom-title-error' : undefined}
					/>
					{#if titleError}
						<p id="custom-title-error" class="text-sm text-destructive">{titleError}</p>
					{/if}
				</div>

				<div class="flex flex-col gap-1.5">
					<span class="text-sm font-medium">Type</span>
					<ToggleGroup.Root
						type="single"
						value={type}
						onValueChange={(v) => (type = ((v as string) || type) as 'movie' | 'show')}
						variant="outline"
						size="sm"
						class="self-start"
					>
						<ToggleGroup.Item value="movie" class="rounded-l-full!">Movie</ToggleGroup.Item>
						<ToggleGroup.Item value="show" class="rounded-r-full!">Show</ToggleGroup.Item>
					</ToggleGroup.Root>
				</div>

				<div class="flex flex-col gap-1.5">
					<label for="custom-year" class="text-sm font-medium">
						Year <span class="font-normal text-muted-foreground">(optional)</span>
					</label>
					<Input
						id="custom-year"
						type="number"
						inputmode="numeric"
						bind:value={year}
						min={CUSTOM_MIN_YEAR}
						max={CUSTOM_MAX_YEAR}
						placeholder="e.g. 1986"
						class="max-w-40"
						aria-invalid={yearError ? 'true' : undefined}
						aria-describedby={yearError ? 'custom-year-error' : undefined}
					/>
					{#if yearError}
						<p id="custom-year-error" class="text-sm text-destructive">{yearError}</p>
					{/if}
				</div>

				<div class="flex flex-col gap-1.5">
					<label for="custom-overview" class="text-sm font-medium">
						Description <span class="font-normal text-muted-foreground">(optional)</span>
					</label>
					<Textarea id="custom-overview" bind:value={overview} maxlength={CUSTOM_OVERVIEW_MAX} />
				</div>

				{#if type === 'show'}
					<div class="flex flex-col gap-2">
						<div class="flex items-baseline justify-between">
							<span class="text-sm font-medium">Seasons</span>
							<span class="text-xs text-muted-foreground">
								{episodeTotal}
								{episodeTotal === 1 ? 'episode' : 'episodes'}
							</span>
						</div>
						{#if seasons.length === 0}
							<p class="text-sm text-muted-foreground">
								Add a season to tick episodes off as you watch. You can skip this and still track
								the show as a whole.
							</p>
						{/if}
						<ul class="flex flex-col gap-2">
							{#each seasons as season (season.seasonNumber)}
								<li class="flex items-center gap-2">
									<span class="w-20 shrink-0 text-sm">Season {season.seasonNumber}</span>
									<Input
										type="number"
										inputmode="numeric"
										bind:value={season.episodes}
										min={0}
										max={CUSTOM_MAX_EPISODES_PER_SEASON}
										placeholder="Episodes"
										aria-label={`Episodes in season ${season.seasonNumber}`}
										class="max-w-32"
									/>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										onclick={() => removeSeason(season.seasonNumber)}
										aria-label={`Remove season ${season.seasonNumber}`}
									>
										<Trash2Icon class="size-4" />
									</Button>
								</li>
							{/each}
						</ul>
						{#if seasonsError}
							<p class="text-sm text-destructive">{seasonsError}</p>
						{/if}
						<Button
							type="button"
							variant="outline"
							size="sm"
							class="self-start"
							onclick={addSeason}
							disabled={seasons.length >= CUSTOM_MAX_SEASONS ||
								episodeTotal >= CUSTOM_MAX_EPISODES_TOTAL}
						>
							<PlusIcon class="size-4" />
							Add season
						</Button>
					</div>
				{/if}
			</div>

			<div class="flex justify-end gap-2 border-t border-border p-4">
				<Button type="button" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
				<Button type="submit" disabled={busy || (showErrors && !parsed.success)}>
					{editing ? 'Save' : 'Add to list'}
				</Button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>
