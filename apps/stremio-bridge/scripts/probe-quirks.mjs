#!/usr/bin/env node
/**
 * Mutates one library item to answer the three questions the reconcile depends on, then restores
 * it from a snapshot taken first. Run against a test account only.
 *
 *   node --env-file=.probe.env scripts/probe-quirks.mjs
 *
 * 1. Does `datastorePut` replace the item, or merge into it?
 * 2. Does a tombstone (`removed: true`) persist, and does it still come back from `datastoreGet`?
 * 3. Does `{temp: true, removed: true}` — Stremio's "played, never added" — persist?
 */
const API = 'https://api.strem.io/api';
const COLLECTION = 'libraryItem';

const authKey = process.env.STREMIO_AUTH_KEY?.trim();
if (!authKey) {
	console.error('STREMIO_AUTH_KEY is not set. Run with: node --env-file=.probe.env …');
	process.exitCode = 1;
} else {
	await main(authKey);
}

async function main(key) {
	const call = async (name, body) => {
		const response = await fetch(`${API}/${name}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ authKey: key, collection: COLLECTION, ...body })
		});
		const json = await response.json();
		if (json.error) throw new Error(`${name}: ${json.error.code} ${json.error.message}`);
		return json.result;
	};

	const read = async (id) => (await call('datastoreGet', { ids: [id] }))[0] ?? null;
	const put = (item) => call('datastorePut', { changes: [item] });
	const fields = (item) =>
		item
			? Object.keys(item)
					.filter((k) => k !== 'state')
					.sort()
					.join(',')
			: '(absent)';

	const all = await call('datastoreGet', { all: true });
	const target = all.find((item) => item.type === 'series' && !item.removed) ?? all[0];
	if (!target) {
		console.log('No library items to experiment on.');
		return;
	}

	console.log(`target: ${target._id} (${target.type})`);
	const snapshot = structuredClone(target);

	try {
		// 1. Send only some fields and see what survives.
		await put({
			_id: target._id,
			type: target.type,
			state: { ...target.state, timeOffset: 12_345 }
		});
		const minimal = await read(target._id);
		console.log('\n1. put({_id, type, state}) ->');
		console.log('   top-level fields now:', fields(minimal));
		console.log(
			'   name preserved:',
			minimal?.name === target.name,
			'| timeOffset:',
			minimal?.state?.timeOffset
		);

		// 2. Tombstone, and whether it is still visible to a reader.
		await put({ ...snapshot, removed: true });
		const tomb = await read(target._id);
		const meta = await call('datastoreMeta', {});
		console.log('\n2. put({removed: true}) ->');
		console.log('   removed:', tomb?.removed, '| still returned by datastoreGet:', tomb !== null);
		console.log(
			'   present in datastoreMeta:',
			meta.some(([id]) => id === target._id)
		);

		// 3. Played-but-never-added, the state Stremio's own constructor produces.
		await put({ ...snapshot, removed: true, temp: true });
		const temp = await read(target._id);
		console.log('\n3. put({removed: true, temp: true}) ->');
		console.log(
			'   temp:',
			temp?.temp,
			'| removed:',
			temp?.removed,
			'| state kept:',
			temp?.state?.watched === snapshot.state?.watched
		);

		// 4. Does an older `_mtime` win, or does the stored one?
		const older = new Date(Date.parse(snapshot._mtime) - 60_000).toISOString();
		await put({ ...snapshot, _mtime: older });
		const stamped = await read(target._id);
		console.log('\n4. put with an older _mtime ->');
		console.log('   stored _mtime is the older one:', stamped?._mtime === older, '| sent', older);
	} finally {
		await put(snapshot);
		const restored = await read(target._id);
		const same = JSON.stringify(restored) === JSON.stringify(snapshot);
		console.log(`\nrestored: ${same ? 'identical to the snapshot' : 'DIFFERS — snapshot was:'}`);
		if (!same) console.log(JSON.stringify(snapshot, null, 2));
	}
}
