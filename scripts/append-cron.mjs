// Appends `scheduled`/`queue` to the fetch-only `_worker.js` adapter-cloudflare emits — nothing here compiles TS or resolves `#lib`, so the handlers self-fetch internal routes.
import { appendFile, readFile, writeFile } from 'node:fs/promises';

const WORKER = '.svelte-kit/cloudflare/_worker.js';
const WRANGLER = 'wrangler.jsonc';

const JOB_ROUTES = {
	MEDIA_REFRESH_QUEUE: '/api/queue/media-refresh'
};

let src = await readFile(WORKER, 'utf8');
// adapter-cloudflare v8 exports anonymously, and the appended handlers need a name.
const defaultExports = src.split('export default {').length - 1;
if (defaultExports !== 1) {
	throw new Error(
		`append-cron: expected exactly one \`export default {\` in ${WORKER}, found ${defaultExports} — adapter-cloudflare output changed, update this script.`
	);
}
src = src.replace('export default {', 'const worker_default = {');
await writeFile(WORKER, src, 'utf8');
// Second append would duplicate a `const` declaration and break parsing. Vite rewrites _worker.js
// on every build, so this only fires when re-run against an existing one.
if (src.includes('QUEUE_ROUTES')) {
	console.log('append-cron: handlers already present in', WORKER, '— nothing to do.');
	process.exit(0);
}

// Derived from wrangler.jsonc: a rename would otherwise leave QUEUE_ROUTES[batch.queue] undefined, silently dead-lettering the backlog.
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
	// Three schedules: the daily maintenance sweep (0 6 * * *), the waitlist digest for admins (0 7 * * *)
	// and the hourly notifications digest (0 * * * *, so 9AM lands in every timezone). Route each cron to
	// its own endpoint.
	const path =
		event.cron === '0 6 * * *'
			? '/api/cron/refresh'
			: event.cron === '0 7 * * *'
				? '/api/cron/waitlist-digest'
				: '/api/cron/notify';
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
await appendFile(WORKER, '\nexport default worker_default;\n', 'utf8');
console.log('append-cron: attached scheduled + queue handlers to', WORKER);
