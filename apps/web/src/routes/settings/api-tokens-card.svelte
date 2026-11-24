<script lang="ts">
	import { onMount } from 'svelte';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { sync } from '#lib/client/sync/engine.svelte.js';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import TrashIcon from '@lucide/svelte/icons/trash-2';

	interface TokenRow {
		id: string;
		hint: string;
		label: string;
		scopes: string[];
		createdAt: number;
		lastUsedAt: number | null;
		expiresAt: number | null;
		revokedAt: number | null;
	}

	let tokens = $state<TokenRow[]>([]);
	let label = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let loaded = $state(false);
	let plaintext = $state<string | null>(null);
	let copied = $state(false);
	let confirming = $state<string | null>(null);

	const online = $derived(sync.online);
	const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

	async function loadTokens() {
		try {
			const res = await fetch('/api/tokens');
			if (!res.ok) throw new Error(String(res.status));
			tokens = ((await res.json()) as { tokens: TokenRow[] }).tokens;
		} catch {
			error = "Couldn't load your API tokens.";
		} finally {
			loaded = true;
		}
	}

	onMount(loadTokens);

	async function createToken() {
		busy = true;
		error = null;
		copied = false;
		try {
			const res = await fetch('/api/tokens', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ label })
			});
			if (!res.ok) {
				error = res.status === 400 ? 'Give the token a name.' : "Couldn't create a token.";
				return;
			}
			plaintext = ((await res.json()) as { token: string }).token;
			label = '';
			await loadTokens();
		} catch {
			error = "Couldn't create a token right now.";
		} finally {
			busy = false;
		}
	}

	async function revokeToken(id: string) {
		busy = true;
		error = null;
		try {
			const res = await fetch(`/api/tokens/${id}`, { method: 'DELETE' });
			if (res.status === 404) error = 'That token was already revoked.';
			else if (!res.ok) error = "Couldn't revoke that token.";
		} catch {
			error = "Couldn't revoke that token right now.";
		} finally {
			busy = false;
			confirming = null;
			await loadTokens();
		}
	}

	async function copyToken() {
		if (!plaintext) return;
		try {
			await navigator.clipboard.writeText(plaintext);
			copied = true;
		} catch {
			error = 'Copy failed — select the token and copy it manually.';
		}
	}
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>API tokens</Card.Title>
		<Card.Description>
			Let external apps read and update your library. A token acts as you, so keep it secret.
		</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-4">
		{#if plaintext}
			<div class="rounded-lg border border-primary/40 bg-primary/5 p-3">
				<p class="text-sm font-medium">Copy this token now</p>
				<p class="text-xs text-muted-foreground">
					This is the only time you'll see it — we can't show it again.
				</p>
				<div class="mt-2 flex items-center gap-2">
					<code class="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
						{plaintext}
					</code>
					<Button variant="outline" size="sm" onclick={copyToken}>
						<CopyIcon class="size-4" />
						{copied ? 'Copied' : 'Copy'}
					</Button>
				</div>
				<Button variant="ghost" size="sm" class="mt-2" onclick={() => (plaintext = null)}>
					Done
				</Button>
			</div>
		{/if}

		{#if loaded && tokens.length > 0}
			<ul class="flex flex-col gap-2">
				{#each tokens as token (token.id)}
					<li class="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
						<div class="min-w-0">
							<p class="truncate text-sm">
								{token.label}
								<span class="text-muted-foreground">· …{token.hint}</span>
								{#if token.revokedAt}
									<span class="text-muted-foreground">· revoked</span>
								{/if}
							</p>
							<p class="text-xs text-muted-foreground">
								{#if token.lastUsedAt}
									Last used {dateFmt.format(new Date(token.lastUsedAt))}
								{:else}
									Created {dateFmt.format(new Date(token.createdAt))}
								{/if}
							</p>
						</div>
						{#if !token.revokedAt}
							{#if confirming === token.id}
								<div class="flex shrink-0 items-center gap-2">
									<Button
										variant="destructive"
										size="sm"
										disabled={busy || !online}
										onclick={() => revokeToken(token.id)}
									>
										Revoke
									</Button>
									<Button variant="ghost" size="sm" onclick={() => (confirming = null)}>
										Cancel
									</Button>
								</div>
							{:else}
								<Button
									variant="ghost"
									size="icon-sm"
									class="shrink-0"
									aria-label="Revoke token"
									disabled={busy || !online}
									onclick={() => (confirming = token.id)}
								>
									<TrashIcon class="size-4" />
								</Button>
							{/if}
						{/if}
					</li>
				{/each}
			</ul>
		{:else if loaded}
			<p class="text-sm text-muted-foreground">No API tokens yet.</p>
		{/if}

		<div class="flex flex-col gap-2">
			<Input
				aria-label="Token name"
				placeholder="Name (e.g. Laptop script)"
				maxlength={60}
				bind:value={label}
				disabled={busy || !online}
			/>
			<Button class="self-start" size="sm" onclick={createToken} disabled={busy || !online}>
				{busy ? 'Working…' : 'Create a token'}
			</Button>
		</div>

		{#if error}
			<p class="text-sm text-destructive">{error}</p>
		{:else if !online}
			<p class="text-sm text-muted-foreground">
				You're offline — tokens can only be created or revoked online.
			</p>
		{/if}
	</Card.Content>
</Card.Root>
