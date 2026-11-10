<script lang="ts">
	import { onMount } from 'svelte';
	import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
	import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/server';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { sync } from '#lib/client/sync/engine.svelte.js';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import XIcon from '@lucide/svelte/icons/x';

	interface PasskeyRow {
		id: string;
		name: string;
		backedUp: boolean;
		createdAt: number;
		lastUsedAt: number | null;
	}

	let passkeys = $state<PasskeyRow[]>([]);
	let name = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let loaded = $state(false);

	const supported = browserSupportsWebAuthn();
	const online = $derived(sync.online);
	const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

	// 403 is the fresh-sign-in rule for credential changes; 429 is the per-client ceremony cap.
	function failure(res: Response): string {
		if (res.status === 403) return 'For your security, sign out and back in, then try again.';
		if (res.status === 429) return 'Too many attempts — try again in a few minutes.';
		return "That didn't work. Try again.";
	}

	async function loadPasskeys() {
		try {
			const res = await fetch('/api/passkey');
			if (!res.ok) throw new Error(String(res.status));
			passkeys = ((await res.json()) as { passkeys: PasskeyRow[] }).passkeys;
			error = null;
		} catch {
			error = "Couldn't load your passkeys.";
		} finally {
			loaded = true;
		}
	}

	onMount(loadPasskeys);

	async function addPasskey() {
		busy = true;
		error = null;
		try {
			const optionsRes = await fetch('/api/passkey/register/options', { method: 'POST' });
			if (!optionsRes.ok) {
				error = failure(optionsRes);
				return;
			}
			const optionsJSON = (await optionsRes.json()) as PublicKeyCredentialCreationOptionsJSON;

			let registration;
			try {
				registration = await startRegistration({ optionsJSON });
			} catch {
				error = 'Setup was cancelled or this device can’t create a passkey.';
				return;
			}

			const verifyRes = await fetch('/api/passkey/register/verify', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ response: registration, name })
			});
			if (!verifyRes.ok) {
				error =
					verifyRes.status === 400
						? "Your browser's passkey could not be verified. Try again."
						: failure(verifyRes);
				return;
			}
			name = '';
			await loadPasskeys();
		} catch {
			error = "Couldn't add a passkey right now.";
		} finally {
			busy = false;
		}
	}

	async function removePasskey(passkey: PasskeyRow) {
		busy = true;
		error = null;
		try {
			const res = await fetch(`/api/passkey/${passkey.id}`, { method: 'DELETE' });
			// Only 403/429 are worth surfacing; a 404 just means the list was stale.
			if (res.status === 403 || res.status === 429) error = failure(res);
		} catch {
			// Best-effort — the reload below reflects the real state.
		} finally {
			busy = false;
			await loadPasskeys();
		}
	}
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Passkeys</Card.Title>
		<Card.Description>
			Sign in with Face ID, Touch ID, Windows Hello or a security key — no email needed.
		</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-4">
		{#if !supported}
			<p class="text-sm text-muted-foreground">Passkeys aren't supported in this browser.</p>
		{:else}
			{#if loaded && passkeys.length > 0}
				<ul class="flex flex-col gap-2">
					{#each passkeys as passkey (passkey.id)}
						<li class="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
							<div class="min-w-0">
								<p class="truncate text-sm">
									<KeyRoundIcon class="mr-1 inline size-4 align-text-bottom" />
									{passkey.name}
									{#if passkey.backedUp}
										<span class="text-muted-foreground">· synced</span>
									{/if}
								</p>
								<p class="text-xs text-muted-foreground">
									{#if passkey.lastUsedAt}
										Last used {dateFmt.format(new Date(passkey.lastUsedAt))}
									{:else}
										Added {dateFmt.format(new Date(passkey.createdAt))}
									{/if}
								</p>
							</div>
							<Button
								variant="ghost"
								size="icon-sm"
								class="shrink-0"
								aria-label="Remove passkey"
								disabled={busy}
								onclick={() => removePasskey(passkey)}
							>
								<XIcon class="size-4" />
							</Button>
						</li>
					{/each}
				</ul>
			{:else if loaded}
				<p class="text-sm text-muted-foreground">
					No passkeys yet — add one to skip the email step when signing in.
				</p>
			{/if}

			<div class="flex flex-col gap-2">
				<Input
					aria-label="Passkey name"
					placeholder="Name (e.g. MacBook Touch ID)"
					maxlength={40}
					bind:value={name}
					disabled={busy || !online}
				/>
				<Button class="self-start" size="sm" onclick={addPasskey} disabled={busy || !online}>
					{busy ? 'Working…' : 'Add a passkey'}
				</Button>
			</div>

			{#if error}
				<p class="text-sm text-destructive">{error}</p>
			{:else if !online}
				<p class="text-sm text-muted-foreground">
					You're offline — passkeys can only be added or removed online.
				</p>
			{/if}
		{/if}
	</Card.Content>
</Card.Root>
