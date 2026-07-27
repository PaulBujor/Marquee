/**
 * Post-build step: attach a `scheduled` (cron) handler to the worker adapter-cloudflare emits.
 * The adapter generates a fetch-only `_worker.js` (exporting a `worker_default` object) and has no
 * option for other handlers, so we append one that self-invokes the internal cron routes through the
 * worker's own `fetch`, branching on the schedule (maintenance vs. notifications). Runs after
 * `vite build` (see the `build` script).
 */
import { appendFile, readFile } from 'node:fs/promises';

const WORKER = '.svelte-kit/cloudflare/_worker.js';

const src = await readFile(WORKER, 'utf8');
if (!src.includes('worker_default')) {
	throw new Error(
		`append-cron: expected \`worker_default\` in ${WORKER} — adapter-cloudflare output changed, update this script.`
	);
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
console.log('append-cron: attached scheduled handler to', WORKER);
