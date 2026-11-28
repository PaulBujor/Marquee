#!/usr/bin/env node
/**
 * Creates one library item that Stremio did not have, from Cinemeta's own metadata, and reads it
 * back to see what Stremio accepts and normalises.
 *
 *   node --env-file=.probe.env scripts/probe-create.mjs
 *
 * The question: an *update* round-trips (proven earlier), but a *create* has no existing item to
 * echo — we supply name, poster, type, timestamps and a partial state. If Stremio accepts that,
 * the reconcile can add a Marquee title to a user's Stremio library instead of calling it a
 * conflict forever.
 *
 * Stremio has no delete, so the item is tombstoned afterwards (removed: true): invisible in the
 * library UI, but it stays in the collection. That residue is the price of the answer.
 */
import watchedBitfield from 'stremio-watched-bitfield';

const API = 'https://api.strem.io/api';
const COLLECTION = 'libraryItem';
/** A well-known series; skipped if the account already has it. */
const CANDIDATES = ['tt0386676', 'tt0108778', 'tt0898266'];

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

	const library = await call('datastoreGet', { all: true });
	const have = new Set(library.map((item) => item._id));
	const id = CANDIDATES.find((candidate) => !have.has(candidate));
	if (!id) {
		console.log('Every candidate is already in this library.');
		return;
	}

	// Stremio's own metadata, so the item is built from what Stremio would render.
	const meta = (await (await fetch(`https://v3-cinemeta.strem.io/meta/series/${id}.json`)).json())
		?.meta;
	if (!meta?.name) {
		console.log(`Cinemeta has no series ${id} — this is the "not on the platform" case: ignore.`);
		return;
	}

	const keys = (meta.videos ?? []).map((video) => video.id);
	const first = keys[0] ?? id;
	const watched = watchedBitfield
		.constructFromArray(
			keys.map((videoKey) => videoKey === first),
			keys
		)
		.serialize();
	const now = new Date().toISOString();

	// Deliberately minimal: only what a library view needs, and a state holding one watched bit.
	const item = {
		_id: id,
		type: 'series',
		name: meta.name,
		poster: meta.poster,
		posterShape: 'poster',
		removed: false,
		temp: false,
		_ctime: now,
		_mtime: now,
		state: { watched, video_id: first }
	};

	console.log(`creating ${id} (${meta.name}) from Cinemeta, ${keys.length} catalogue videos`);
	console.log(
		'sent:',
		JSON.stringify({ ...item, state: { ...item.state, watched: `(${watched.length} chars)` } })
	);

	await call('datastorePut', { changes: [item] });

	const back = (await call('datastoreGet', { ids: [id] }))[0] ?? null;
	if (!back) {
		console.log('\n!! Stremio did not return the item it accepted.');
		return;
	}

	const survived = (field) => back[field] === item[field];
	console.log('\n--- what came back ---');
	console.log(
		'name/poster/posterShape/type survived:',
		['name', 'poster', 'posterShape', 'type'].every(survived)
	);
	console.log('temp/removed:', back.temp, back.removed);
	console.log('state keys:', Object.keys(back.state ?? {}).join(','));
	console.log(
		'watched bitfield accepted:',
		(back.state?.watched ?? '') === watched,
		'| decodes to:',
		keys
			.filter((videoKey) =>
				watchedBitfield
					.constructAndResize(String(back.state?.watched ?? ''), keys)
					.getVideo(videoKey)
			)
			.join(', ') || '(nothing)'
	);

	const tombstone = (await call('datastoreGet', { all: true })).find((item) => item._id === id);
	await call('datastorePut', { changes: [{ ...tombstone, removed: true }] });
	const hidden = (await call('datastoreGet', { ids: [id] }))[0] ?? null;
	console.log(`\ntombstoned to keep it out of the library view: removed=${hidden?.removed}`);
}
