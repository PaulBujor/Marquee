<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { InputGroup, InputGroupInput, InputGroupSelect } from '$lib/components/ui/input-group';
	import PersonAvatar from './person-avatar.svelte';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { sync } from '$lib/client/sync/engine.svelte';
	import { creditRoleLabel } from '$lib/credits';
	import { CREDIT_ROLES } from '$lib/sync/events';
	import { CUSTOM_NAME_MAX, type CustomCreditInput } from '$lib/validation/custom-media';
	import type { PersonSearchResult, SearchResult } from '$lib/server/tmdb';

	/**
	 * One credited person: role + name field with type-ahead against the provider's people catalog.
	 * The search is a spelling aid — picking someone fills in the name but stays private to the entry.
	 */
	interface Props {
		credit: CustomCreditInput;
		onremove: () => void;
	}
	let { credit = $bindable(), onremove }: Props = $props();

	const DEBOUNCE_MS = 300;
	const MAX_SUGGESTIONS = 6;
	/** Below this, a query matches half the database and the results are noise. */
	const MIN_QUERY = 2;

	let suggestions = $state<PersonSearchResult[]>([]);
	let open = $state(false);
	let highlighted = $state(-1);
	let inputEl = $state<HTMLInputElement | null>(null);

	let timer: ReturnType<typeof setTimeout> | null = null;
	/** Guards against a slow response for an earlier query landing after a newer one. */
	let latestQuery = '';
	const listId = `credit-people-${Math.random().toString(36).slice(2, 9)}`;

	function close() {
		open = false;
		highlighted = -1;
	}

	function reset() {
		if (timer) clearTimeout(timer);
		timer = null;
		suggestions = [];
		close();
	}

	async function runSearch(query: string) {
		latestQuery = query;
		try {
			const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
			if (!res.ok) throw new Error(String(res.status));
			const body = (await res.json()) as { results: SearchResult[] };
			if (latestQuery !== query) return; // a newer keystroke superseded this one
			suggestions = body.results
				.filter((r): r is { kind: 'person' } & PersonSearchResult => r.kind === 'person')
				.slice(0, MAX_SUGGESTIONS);
			open = suggestions.length > 0;
			highlighted = -1;
		} catch {
			// A failed lookup must never block authoring — the typed name still stands.
			if (latestQuery === query) reset();
		}
	}

	function onInput() {
		// The name no longer belongs to whoever was picked, so the hint goes with it.
		credit.externalId = null;
		credit.profilePath = null;
		if (timer) clearTimeout(timer);
		const query = credit.name.trim();
		if (!sync.online || query.length < MIN_QUERY) {
			reset();
			return;
		}
		timer = setTimeout(() => runSearch(query), DEBOUNCE_MS);
	}

	function choose(person: PersonSearchResult) {
		credit.name = person.name;
		credit.externalId = `person/${person.tmdbId}`;
		credit.profilePath = person.profilePath;
		reset();
		inputEl?.focus();
	}

	function onKeydown(event: KeyboardEvent) {
		if (!open) return;
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			highlighted = highlighted >= suggestions.length - 1 ? 0 : highlighted + 1;
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			highlighted = highlighted <= 0 ? suggestions.length - 1 : highlighted - 1;
		} else if (event.key === 'Enter' && highlighted >= 0) {
			// Only swallow Enter while a suggestion is selected; otherwise the form submits as usual.
			event.preventDefault();
			choose(suggestions[highlighted]);
		} else if (event.key === 'Escape') {
			event.stopPropagation(); // close the list, not the dialog around it
			close();
		}
	}

	/** A one-line hint of who this is, so two people with the same name are tellable apart. */
	function subtitle(person: PersonSearchResult): string {
		const known = person.knownFor.slice(0, 2).join(', ');
		if (person.department && known) return `${person.department} · ${known}`;
		return person.department ?? known;
	}
</script>

<li class="flex flex-col gap-1.5">
	<div class="flex items-center gap-2">
		<InputGroup class="flex-1">
			<InputGroupSelect bind:value={credit.role} aria-label="Role" class="w-28">
				{#each CREDIT_ROLES as role (role)}
					<option value={role}>{creditRoleLabel(role)}</option>
				{/each}
			</InputGroupSelect>
			<InputGroupInput
				bind:ref={inputEl}
				bind:value={credit.name}
				oninput={onInput}
				onkeydown={onKeydown}
				onblur={() => setTimeout(close, 120)}
				autocomplete="off"
				autocapitalize="words"
				spellcheck="false"
				role="combobox"
				aria-expanded={open}
				aria-controls={listId}
				aria-autocomplete="list"
				aria-label="Name"
				placeholder="Name"
				maxlength={CUSTOM_NAME_MAX}
			/>
		</InputGroup>
		<Button
			type="button"
			variant="ghost"
			size="icon"
			class="shrink-0"
			onclick={onremove}
			aria-label={credit.name ? `Remove ${credit.name}` : 'Remove this credit'}
		>
			<Trash2Icon class="size-4" />
		</Button>
	</div>

	{#if open}
		<ul
			id={listId}
			role="listbox"
			aria-label="Matching people"
			class="flex flex-col overflow-hidden rounded-md border border-border bg-popover"
		>
			{#each suggestions as person, i (person.tmdbId)}
				<li role="option" aria-selected={highlighted === i}>
					<button
						type="button"
						class={[
							'flex w-full items-center gap-2.5 px-2.5 py-2 text-left transition-colors hover:bg-accent',
							highlighted === i && 'bg-accent'
						]}
						onmousedown={(e) => e.preventDefault()}
						onclick={() => choose(person)}
					>
						<PersonAvatar
							name={person.name}
							profilePath={person.profilePath}
							size="w185"
							class="size-8 shrink-0"
						/>
						<span class="flex min-w-0 flex-col">
							<span class="truncate text-sm">{person.name}</span>
							{#if subtitle(person)}
								<span class="truncate text-xs text-muted-foreground">{subtitle(person)}</span>
							{/if}
						</span>
					</button>
				</li>
			{/each}
		</ul>
	{/if}

	{#if credit.role === 'cast'}
		<Input
			bind:value={credit.character}
			autocomplete="off"
			aria-label={credit.name ? `Character played by ${credit.name}` : 'Character'}
			placeholder="Character (optional)"
			maxlength={CUSTOM_NAME_MAX}
			class="w-[calc(100%-3rem)]"
		/>
	{/if}
</li>
