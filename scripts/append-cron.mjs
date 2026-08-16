/**
 * Post-build step: attach `scheduled` (cron) and `queue` (Cloudflare Queues) handlers to the
 * worker adapter-cloudflare emits. The adapter generates a fetch-only `_worker.js` (exporting a
 * `worker_default` object) and has no option for other handlers, so we append handlers that
 * self-invoke the internal cron/queue routes through the worker's own `fetch` rather than
 * importing app code directly (this script has no build step of its own to compile TS/resolve
 * `$lib` aliases). `scheduled` branches on the schedule (maintenance vs. notifications); `queue`
 * routes a batch (by its Cloudflare queue name, see QUEUE_ROUTES below) to the matching internal
 * route and applies the outcomes it returns to the real `Message` objects — that's the only place
 * the ack/retry decision can be applied, since it requires the objects this invocation holds.
 * `queue` is deliberately job-agnostic: it knows nothing about media refresh specifically, so a
 * second queue-backed job (e.g. the push digest) is one more JOB_ROUTES entry plus its
 * `queues` bindings in wrangler.jsonc, not a change to the relay. The queue-name map it emits is
 * derived from those bindings, so a rename can't silently desync. Appending is idempotent — a
 * re-run against an already-patched worker is a no-op rather than a duplicate declaration. Runs
 * after `vite build` (see the `build` script).
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
// The appended blocks declare module-scope consts, so a second append would produce a worker that
// fails to parse (`Identifier 'QUEUE_ROUTES' has already been declared`). Vite rewrites _worker.js
// on every build, so this only trips when the post-build step is re-run against an existing one.
if (src.includes('QUEUE_ROUTES')) {
	console.log('append-cron: handlers already present in', WORKER, '— nothing to do.');
	process.exit(0);
}

// Derive the queue -> route map from wrangler.jsonc rather than restating queue names here. A
// rename or a new consumer would otherwise leave `QUEUE_ROUTES[batch.queue]` undefined at runtime,
// which retries every batch until the whole backlog dead-letters — a silent, deploy-time-invisible
// failure. Fail the build instead.
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
	// The route decides ack/retry per message (attempt cap, etc. — see e.g. refresh-consumer.ts);
	// this handler is a mechanical relay, not a policy. On a total failure (route unreachable,
	// throws before responding) every message is retried and Cloudflare's own max_retries/DLQ
	// becomes the backstop, since no per-message decision was ever computed.
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
