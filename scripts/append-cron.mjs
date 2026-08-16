/**
 * Post-build step: attach `scheduled` and `queue` handlers to the worker adapter-cloudflare
 * emits. The adapter produces a fetch-only `_worker.js`, so we append handlers that self-fetch
 * the matching internal routes rather than importing app code (no build step here to compile TS
 * or resolve `$lib`). `scheduled` branches on the cron schedule; `queue` routes a batch by its
 * Cloudflare queue name to an internal route, which returns per-message ack/retry outcomes that
 * this handler applies to the real `Message` objects — the only place that's possible, since it
 * requires the objects this invocation holds. The route map is derived from wrangler.jsonc bindings
 * so a rename can't silently desync. Appending is idempotent. Runs after `vite build`.
 */
import { appendFile, readFile } from 'node:fs/promises';

const WORKER = '.svelte-kit/cloudflare/_worker.js';
const WRANGLER = 'wrangler.jsonc';

/** Internal route consuming each queue-backed job, keyed by the job's producer binding. */
const JOB_ROUTES = {
	MEDIA_REFRESH_QUEUE: '/api/queue/media-refresh'
};

const src = await readFile(WORKER, 'utf8');
if (!src.includes('worker_default')) {
	throw new Error(
		`append-cron: expected \`worker_default\` in ${WORKER} — adapter-cloudflare output changed, update this script.`
	);
}
// Second append would duplicate a `const` declaration and break parsing. Vite rewrites _worker.js
// on every build, so this only fires when re-run against an existing one.
if (src.includes('QUEUE_ROUTES')) {
	console.log('append-cron: handlers already present in', WORKER, '— nothing to do.');
	process.exit(0);
}

// Derive queue → route from wrangler.jsonc rather than restating names here — a rename would
// otherwise leave QUEUE_ROUTES[batch.queue] undefined, silently dead-lettering the backlog.
const wrangler = JSON.parse(
	(await readFile(WRANGLER, 'utf8'))
		// Strip // comments and trailing commas — enough for this file's JSONC.
		.replace(/^\s*\/\/.*$/gm, '')
		.replace(/,(\s*[}\]])/g, '$1')
);
const envs = [wrangler, ...Object.values(wrangler.env ?? {})];
const queueRoutes = {};
for (const env of envs) {
	const producers = env.queues?.producers ?? [];
	for (const consumer of env.queues?.consumers ?? []) {
		const producer = producers.find((p) => p.queue === consumer.queue);
		const route = producer && JOB_ROUTES[producer.binding];
		if (!route) {
			throw new Error(
				`append-cron: no route for consumer queue "${consumer.queue}" in ${WRANGLER} — ` +
					`add its producer binding to JOB_ROUTES in this script.`
			);
		}
		queueRoutes[consumer.queue] = route;
	}
}
if (Object.keys(queueRoutes).length === 0) {
	throw new Error(`append-cron: no queue consumers found in ${WRANGLER}.`);
}

await appendFile(
	WORKER,
	`
worker_default.scheduled = async (event, env, ctx) => {
	// Two schedules: the daily maintenance sweep (0 6 * * *) and the hourly notifications digest
	// (0 * * * *, so 9AM lands in every timezone). Route each cron to its own endpoint.
	const path = event.cron === '0 6 * * *' ? '/api/cron/refresh' : '/api/cron/notify';
	ctx.waitUntil(
		worker_default.fetch(
			new Request('https://cron' + path, {
				method: 'POST',
				headers: { 'x-cron-key': env.CRON_SECRET ?? '' }
			}),
			env,
			ctx
		)
	);
};
`,
	'utf8'
);

await appendFile(
	WORKER,
	`
// Cloudflare queue name -> internal route that consumes it, generated at build time from
// wrangler.jsonc's queue bindings (both prod and preview queues for a job share one env-agnostic
// route). Add a new job's binding to JOB_ROUTES in scripts/append-cron.mjs, not here.
const QUEUE_ROUTES = ${JSON.stringify(queueRoutes)};

worker_default.queue = async (batch, env, ctx) => {
	const path = QUEUE_ROUTES[batch.queue];
	if (!path) {
		// A queue with no registered route (misconfiguration) — retry rather than silently drop.
		console.error('queue: no route configured for queue', batch.queue);
		batch.retryAll();
		return;
	}
	// Route decides ack/retry per message; this is a mechanical relay. On total failure (route
	// unreachable) every message retries — Cloudflare's max_retries/DLQ is the backstop.
	try {
		const res = await worker_default.fetch(
			new Request('https://cron' + path, {
				method: 'POST',
				headers: { 'x-cron-key': env.CRON_SECRET ?? '', 'content-type': 'application/json' },
				body: JSON.stringify({
					messages: batch.messages.map((m) => ({ body: m.body, attempts: m.attempts }))
				})
			}),
			env,
			ctx
		);
		if (!res.ok) throw new Error(path + ' responded ' + res.status);
		const { outcomes } = await res.json();
		batch.messages.forEach((message, i) => {
			if (outcomes[i] === 'ack') message.ack();
			else message.retry();
		});
	} catch (err) {
		console.error('queue: batch for', batch.queue, 'failed, retrying whole batch', err);
		batch.retryAll();
	}
};
`,
	'utf8'
);
console.log('append-cron: attached scheduled + queue handlers to', WORKER);
