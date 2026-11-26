#!/usr/bin/env node
/**
 * Probes Stremio's account API for the shapes the reconcile has to be built against.
 *
 * Read-only unless `--write` is passed, in which case it echoes one library item back through
 * `datastorePut` **exactly as it was read** and re-reads it, so the diff shows which fields
 * Stremio owns and which it preserves. That is the question this exists to answer.
 *
 *   node --env-file=.dev.vars scripts/probe-stremio.mjs
 *   node --env-file=.dev.vars scripts/probe-stremio.mjs --write
 *
 * Values are redacted on output — the auth key never reaches stdout, and neither does any
 * library text beyond the title, which you need to confirm what was touched.
 */
const API = 'https://api.strem.io/api';

/** Never print a value we cannot vouch for. */
const shape = (value) => {
	if (value === null) return 'null';
	if (Array.isArray(value)) return `array(${value.length})`;
	if (typeof value === 'string') return `string(${value.length})`;
	if (typeof value === 'object') return `object{${Object.keys(value).join(',')}}`;
	return typeof value;
};

const summary = (item) => ({
	_id: item._id,
	name: item.name,
	type: item.type,
	removed: item.removed,
	temp: item.temp,
	_ctime: item._ctime,
	_mtime: item._mtime,
	state: Object.fromEntries(
		Object.entries(item.state ?? {}).map(([key, value]) => [
			key,
			key === 'watched' ? `bitfield(${String(value).length})` : shape(value)
		])
	),
	behaviorHints: item.behaviorHints ? Object.keys(item.behaviorHints) : undefined
});

/** Every leaf path in an object, so a diff names the field rather than the object. */
function paths(value, prefix = '') {
	if (value === null || typeof value !== 'object') return { [prefix || '.']: value };
	if (Array.isArray(value)) {
		if (value.length === 0) return { [prefix]: '[]' };
		return value.reduce(
			(acc, entry, index) => ({ ...acc, ...paths(entry, `${prefix}[${index}]`) }),
			{}
		);
	}
	const entries = Object.entries(value);
	if (entries.length === 0) return { [prefix]: '{}' };
	return entries.reduce(
		(acc, [key, entry]) => ({ ...acc, ...paths(entry, `${prefix}.${key}`) }),
		{}
	);
}

function diff(before, after) {
	const a = paths(before);
	const b = paths(after);
	return {
		added: Object.keys(b).filter((path) => !(path in a)),
		removed: Object.keys(a).filter((path) => !(path in b)),
		changed: Object.keys(a).filter(
			(path) => path in b && JSON.stringify(a[path]) !== JSON.stringify(b[path])
		)
	};
}

async function main() {
	const authKey = process.env.STREMIO_AUTH_KEY?.trim();
	if (!authKey) {
		console.error('STREMIO_AUTH_KEY is not set. Run with: node --env-file=.dev.vars …');
		process.exitCode = 1;
		return;
	}

	const call = async (name, body) => {
		const response = await fetch(`${API}/${name}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ authKey, ...body })
		});
		const json = await response.json();
		if (json.error) throw new Error(`${name}: ${json.error.code} ${json.error.message}`);
		return json;
	};

	const meta = await call('datastoreMeta', { collection: 'libraryItem' });
	console.log('datastoreMeta  envelope:', shape(meta), '| result:', shape(meta.result));

	const got = await call('datastoreGet', { collection: 'libraryItem', all: true });
	console.log('datastoreGet   envelope:', shape(got), '| result:', shape(got.result));

	const items = Array.isArray(got.result) ? got.result : [];
	if (items.length === 0) {
		console.log('\nThis account’s library is empty. Add a series in Stremio and run again.');
		return;
	}

	console.log(
		`\n${items.length} item(s). Types:`,
		[...new Set(items.map((i) => i.type))].join(', ')
	);

	const target =
		items.find((item) => item.type === 'series' && !item.removed) ??
		items.find((item) => !item.removed) ??
		items[0];

	console.log('\n--- target item ---');
	console.log(JSON.stringify(summary(target), null, 2));

	if (!process.argv.includes('--write')) {
		console.log('\nRead-only. Re-run with --write to test datastorePut on this item.');
		return;
	}

	console.log('\n--- echoing it straight back through datastorePut ---');
	const put = await call('datastorePut', { collection: 'libraryItem', changes: [target] });
	console.log('datastorePut   envelope:', shape(put), '| result:', JSON.stringify(put.result));

	const after = await call('datastoreGet', { collection: 'libraryItem', ids: [target._id] });
	const reread = Array.isArray(after.result)
		? after.result.find((item) => item._id === target._id)
		: null;

	if (!reread) {
		console.log('\n!! the item did not come back. Nothing else was touched.');
		process.exitCode = 1;
		return;
	}

	const delta = diff(target, reread);
	console.log('\n--- what changed in the round trip ---');
	console.log(JSON.stringify(delta, null, 2));
	console.log(
		delta.added.length + delta.removed.length + delta.changed.length === 0
			? '\nNo drift: Stremio accepts a faithful echo, so the reconcile can send what it read.'
			: '\nDrift: those paths are fields Stremio owns — the reconcile must preserve them, not guess them.'
	);
}

await main();
