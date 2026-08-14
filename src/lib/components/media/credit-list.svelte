<script lang="ts">
	import { foldName, groupCredits } from '$lib/credits';
	import type { MediaCredit } from '$lib/sync/events';

	/**
	 * Cast and crew as role-grouped lines. Deliberately text, not avatars: this renders credits the
	 * user typed themselves, which have no photos, and the comparison view needs the two sides to
	 * line up section for section.
	 *
	 * `highlight` marks the people both sides of a comparison agree on — folded names, supplied by
	 * the caller so this component stays a renderer.
	 */
	interface Props {
		credits: MediaCredit[];
		highlight?: Set<string>;
		empty?: string;
	}
	let { credits, highlight, empty }: Props = $props();

	const groups = $derived(groupCredits(credits));

	/** How a person reads on one line: their name, and for cast who they played. */
	function line(credit: MediaCredit): string {
		return credit.character ? `${credit.name} as ${credit.character}` : credit.name;
	}
</script>

{#if groups.length === 0}
	{#if empty}
		<p class="text-sm text-muted-foreground">{empty}</p>
	{/if}
{:else}
	<dl class="flex flex-col gap-2">
		{#each groups as group (group.role)}
			<div class="flex gap-3 text-sm">
				<dt class="w-20 shrink-0 text-muted-foreground">{group.label}</dt>
				<dd class="flex min-w-0 flex-1 flex-wrap gap-x-1.5 gap-y-1">
					{#each group.people as person, i (person.personId)}
						<span
							class={highlight?.has(foldName(person.name)) ? 'font-medium text-primary' : undefined}
						>
							{line(person)}{i < group.people.length - 1 ? ',' : ''}
						</span>
					{/each}
				</dd>
			</div>
		{/each}
	</dl>
{/if}
