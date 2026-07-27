<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { notifications } from '$lib/state/notifications.svelte.js';
	import XIcon from '@lucide/svelte/icons/x';

	/** One row of the device list (shape of `GET /api/push/subscriptions`). */
	interface DeviceRow {
		id: string;
		deviceLabel: string | null;
		endpoint: string;
		createdAt: number;
		lastUsedAt: number;
	}

	let devices = $state<DeviceRow[]>([]);
	let listError = $state(false);

	const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

	async function loadDevices() {
		if (!notifications.supported) return;
		listError = false;
		try {
			const res = await fetch('/api/push/subscriptions');
			if (!res.ok) throw new Error(String(res.status));
			devices = ((await res.json()) as { subscriptions: DeviceRow[] }).subscriptions;
		} catch {
			listError = true;
		}
	}

	// Reconcile permission/subscription state and load this account's devices once on open.
	$effect(() => {
		if (!notifications.supported) return;
		void notifications.refresh().then(loadDevices);
	});

	async function deleteDevice(id: string) {
		try {
			await fetch(`/api/push/subscriptions/${id}`, { method: 'DELETE' });
		} catch {
			// Best-effort — the reload below reflects the real state.
		}
	}

	async function toggle() {
		if (notifications.subscribed) {
			// Turning off unsubscribes this device; also drop its server row so the list updates now.
			const endpoint = notifications.endpoint;
			await notifications.disable();
			const mine = endpoint ? devices.find((d) => d.endpoint === endpoint) : undefined;
			if (mine) await deleteDevice(mine.id);
		} else {
			await notifications.enable();
		}
		await loadDevices();
	}

	async function removeDevice(device: DeviceRow) {
		await deleteDevice(device.id);
		// If it's this device, also unsubscribe locally so it stops receiving pushes.
		if (device.endpoint === notifications.endpoint) await notifications.disable();
		await loadDevices();
	}
</script>

<Card.Root data-spec-ref="settings-notifications-section">
	<Card.Header>
		<Card.Title>Notifications</Card.Title>
		<Card.Description>
			Get a heads-up at 9AM your time when new episodes and movies you're tracking are released.
		</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-4">
		{#if !notifications.supported}
			<p class="text-sm text-muted-foreground">Notifications aren't supported in this browser.</p>
		{:else}
			<div class="flex items-center justify-between gap-3">
				<span class="text-sm">
					{notifications.subscribed ? 'On for this device' : 'Off for this device'}
				</span>
				<Button
					variant={notifications.subscribed ? 'outline' : 'default'}
					size="sm"
					onclick={toggle}
					disabled={notifications.busy}
				>
					{notifications.busy ? 'Working…' : notifications.subscribed ? 'Turn off' : 'Enable'}
				</Button>
			</div>
			{#if notifications.permission === 'denied'}
				<p class="text-sm text-destructive">
					Notifications are blocked — enable them in your browser settings.
				</p>
			{:else if notifications.error}
				<p class="text-sm text-destructive">{notifications.error}</p>
			{/if}

			{#if listError}
				<p class="text-sm text-muted-foreground">Couldn't load your devices.</p>
			{:else if devices.length > 0}
				<div class="flex flex-col gap-2">
					<h3 class="text-sm font-medium">Devices</h3>
					<ul class="flex flex-col gap-2">
						{#each devices as device (device.id)}
							<li class="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
								<div class="min-w-0">
									<p class="truncate text-sm">
										{device.deviceLabel ?? 'Unknown device'}
										{#if device.endpoint === notifications.endpoint}
											<span class="text-muted-foreground">· this device</span>
										{/if}
									</p>
									<p class="text-xs text-muted-foreground">
										Last used {dateFmt.format(new Date(device.lastUsedAt))}
									</p>
								</div>
								<Button
									variant="ghost"
									size="icon-sm"
									class="shrink-0"
									aria-label="Remove device"
									onclick={() => removeDevice(device)}
								>
									<XIcon class="size-4" />
								</Button>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		{/if}
	</Card.Content>
</Card.Root>
