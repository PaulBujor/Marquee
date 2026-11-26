import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import PosterTile from './poster-tile.svelte';

// Server-side render: no DOM, but the real component and its real markup — enough to pin what a
// card shows for a title the source catalogue has dropped.
describe('PosterTile', () => {
	it('carries the Unavailable pill once the media row is unavailable', () => {
		const { body } = render(PosterTile, {
			props: { alt: 'A title', unavailableAt: 1_700_000_000_000 }
		});
		expect(body).toContain('Unavailable');
	});

	it('renders no pill while the title is available', () => {
		const { body } = render(PosterTile, { props: { alt: 'A title', unavailableAt: null } });
		expect(body).not.toContain('Unavailable');
	});
});
