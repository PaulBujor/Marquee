<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { buttonVariants } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import CircleUserIcon from '@lucide/svelte/icons/circle-user';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import SettingsIcon from '@lucide/svelte/icons/settings';

	// Structurally typed to avoid importing server-only `User`; the layout only
	// renders this header when a user is present.
	let { user }: { user: { email: string } } = $props();

	let logoutForm = $state<HTMLFormElement | null>(null);
</script>

<header class="flex items-center justify-between border-b px-4 py-3">
	<a href={resolve('/')} class="font-serif text-lg font-semibold">Marquee</a>

	<DropdownMenu.Root>
		<DropdownMenu.Trigger class={buttonVariants({ variant: 'ghost', size: 'sm' })}>
			<CircleUserIcon class="size-4" />
			<span class="max-w-[12rem] truncate">{user.email}</span>
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="end" class="w-56">
			<DropdownMenu.Label class="truncate font-normal text-muted-foreground">
				{user.email}
			</DropdownMenu.Label>
			<DropdownMenu.Separator />
			<DropdownMenu.Item>
				{#snippet child({ props })}
					<a href={resolve('/settings')} {...props}>
						<SettingsIcon class="size-4" />
						Settings
					</a>
				{/snippet}
			</DropdownMenu.Item>
			<DropdownMenu.Item variant="destructive" onSelect={() => logoutForm?.requestSubmit()}>
				<LogOutIcon class="size-4" />
				Sign out
			</DropdownMenu.Item>
		</DropdownMenu.Content>
	</DropdownMenu.Root>

	<!-- Actual sign-out submits the existing root `?/logout` action (redirects to /login). -->
	<form bind:this={logoutForm} method="POST" action="/?/logout" class="hidden" use:enhance></form>
</header>
