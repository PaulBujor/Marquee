<script lang="ts">
	import { resolve } from '$app/paths';
	import * as Card from '#lib/components/ui/card/index.js';
	import BackButton from '#lib/components/back-button.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head>
	<title>{data.target.email} · Admin</title>
</svelte:head>

<div class="flex items-start gap-2">
	<BackButton fallback={resolve('/admin/users')} label="All users" />
	<h1 class="min-w-0 pt-1 text-xl font-semibold break-all">{data.target.email}</h1>
</div>

<div class="mt-3 flex flex-wrap items-center gap-2">
	<Badge
		variant={data.target.status === 'blocked'
			? 'destructive'
			: data.target.status === 'pending'
				? 'secondary'
				: 'outline'}
		class="capitalize">{data.target.status}</Badge
	>
	{#if data.target.role === 'admin'}
		<Badge variant="outline">Admin</Badge>
	{/if}
</div>

<dl class="mt-5 grid grid-cols-2 gap-3 text-sm">
	<dt class="text-muted-foreground">Joined</dt>
	<dd>{new Date(data.target.createdAt).toLocaleString()}</dd>
	<dt class="text-muted-foreground">Signup IP</dt>
	<dd>{data.target.signupIp ?? '—'}</dd>
	{#if data.target.blockedReason}
		<dt class="text-muted-foreground">Blocked because</dt>
		<dd class="break-words">{data.target.blockedReason}</dd>
	{/if}
</dl>

{#if form?.enabled}
	<p class="mt-5 text-sm">
		Access enabled.
		{#if form.emailed}
			They were sent a welcome email.
		{:else}
			The welcome email could not be sent — they can sign in regardless.
		{/if}
	</p>
{:else if form?.blocked}
	<p class="mt-5 text-sm">
		Account blocked.
		{#if form.emailed}
			They were emailed the reason.
		{:else}
			The email could not be sent — their access is still removed.
		{/if}
	</p>
{:else if form?.unblocked}
	<p class="mt-5 text-sm">
		Access restored.
		{#if form.emailed}
			They were emailed to say so.
		{:else}
			The email could not be sent — they can sign in regardless.
		{/if}
	</p>
{:else if data.target.status === 'pending'}
	<Card.Root class="mt-5">
		<Card.Header>
			<Card.Title>Admit this account</Card.Title>
			<Card.Description>
				They can sign in as soon as this is done, and are sent a welcome email.
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-3">
			<form method="POST" action="?/enable">
				<Button type="submit">Enable access</Button>
			</form>
			{#if form?.message}
				<p class="text-sm text-destructive">{form.message}</p>
			{/if}
		</Card.Content>
	</Card.Root>
{:else if data.target.status === 'blocked'}
	<Card.Root class="mt-5">
		<Card.Content>
			<form method="POST" action="?/unblock">
				<Button type="submit" variant="outline">Restore access</Button>
			</form>
		</Card.Content>
	</Card.Root>
{:else}
	<Card.Root class="mt-5">
		<Card.Header>
			<Card.Title>Block this account</Card.Title>
			<Card.Description>
				Signs them out everywhere and stops them signing in again. The reason is sent to them by
				email.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<form method="POST" action="?/block" class="flex flex-col gap-3">
				<label class="text-sm font-medium" for="reason">Reason</label>
				<Textarea
					id="reason"
					name="reason"
					required
					minlength={5}
					rows={3}
					value={form?.reason ?? ''}
					placeholder="Chargeback on the annual plan"
				/>
				{#if form?.message}
					<p class="text-sm text-destructive">{form.message}</p>
				{/if}
				<Button type="submit" variant="destructive" class="self-start" disabled={data.isSelf}>
					Block account
				</Button>
				{#if data.isSelf}
					<p class="text-sm text-muted-foreground">You cannot block your own account.</p>
				{/if}
			</form>
		</Card.Content>
	</Card.Root>
{/if}

<Card.Root class="mt-5 ring-destructive/30">
	<Card.Header>
		<Card.Title>Delete this account</Card.Title>
		<Card.Description>
			Removes the account and everything it owns — tracked titles, custom titles and watch history —
			and emails them to say so. This cannot be undone.
		</Card.Description>
	</Card.Header>
	<Card.Content>
		<form method="POST" action="?/delete" class="flex flex-col gap-3">
			<label class="text-sm font-medium" for="confirm">Type {data.target.email} to confirm</label>
			<Input id="confirm" name="confirm" required autocomplete="off" />
			{#if form && 'deleteError' in form}
				<p class="text-sm text-destructive">{form.deleteError}</p>
			{/if}
			<Button type="submit" variant="destructive" class="self-start" disabled={data.isSelf}>
				Delete account
			</Button>
		</form>
	</Card.Content>
</Card.Root>
