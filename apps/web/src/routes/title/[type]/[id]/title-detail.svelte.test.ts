import 'fake-indexeddb/auto';
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { MediaDetail } from '#lib/server/tmdb/index.js';

// `title-detail.svelte` only ever runs inside the app shell; these are the three runtime modules it
// reads that don't exist outside SvelteKit.
vi.mock('$app/navigation', () => ({ afterNavigate: () => {}, invalidate: async () => {} }));
vi.mock('$app/paths', () => ({ resolve: () => '/' }));
vi.mock('$app/state', () => ({ page: { state: {}, url: new URL('http://localhost/') } }));
// The controls are gated on `tracking.ready`, which only a client-side effect sets — so the render
// would show skeletons. Same real `TrackingState`, just already loaded.
vi.mock('#lib/tracking/tracking.svelte.js', async (importOriginal) => {
	const mod = await importOriginal<typeof import('#lib/tracking/tracking.svelte.js')>();
	class LoadedTrackingState extends mod.TrackingState {
		constructor(...args: ConstructorParameters<typeof mod.TrackingState>) {
			super(...args);
			this.ready = true;
		}
	}
	return { ...mod, TrackingState: LoadedTrackingState };
});

import TitleDetail from './title-detail.svelte';

const detail: MediaDetail = {
	tmdbId: 603,
	imdbId: null,
	type: 'movie',
	title: 'The Matrix',
	year: 1999,
	overview: 'A hacker learns the truth.',
	posterPath: null,
	backdropPath: null,
	rating: 8.2,
	voteCount: 10,
	runtime: 136,
	genres: [],
	cast: [],
	director: null,
	writers: [],
	producers: [],
	creators: [],
	trailer: null,
	releaseDate: '1999-03-31',
	status: null,
	inProduction: null,
	firstAirDate: null,
	lastAirDate: null,
	seasons: [],
	similar: []
};

function renderDetail(unavailableAt: number | null): string {
	return render(TitleDetail, {
		props: { detail, season: null, enrichState: 'enriched' as const, unavailableAt }
	}).body;
}

describe('TitleDetail — a title the source catalogue dropped', () => {
	it('explains the stale data once unavailable', () => {
		const body = renderDetail(1_700_000_000_000);
		expect(body).toContain('Unavailable');
		expect(body).toContain('No longer listed on TMDB');
	});

	it('says nothing extra while the title is available', () => {
		const body = renderDetail(null);
		expect(body).not.toContain('Unavailable');
		expect(body).not.toContain('No longer listed on TMDB');
	});

	it('still offers the tracking controls, so the title stays manageable', () => {
		expect(renderDetail(1_700_000_000_000)).toContain('Add to list');
	});
});
