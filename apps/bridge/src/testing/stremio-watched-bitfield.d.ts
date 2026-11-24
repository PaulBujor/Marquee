// `stremio-watched-bitfield` ships no types; only the surface this repo calls is declared.
declare module 'stremio-watched-bitfield' {
	interface WatchedBitfieldInstance {
		get(idx: number): boolean;
		set(idx: number, watched: boolean): void;
		getVideo(videoId: string): boolean;
		setVideo(videoId: string, watched: boolean): void;
		serialize(): string;
	}

	interface WatchedBitfield {
		constructFromArray(arr: boolean[], videoIds: string[]): WatchedBitfieldInstance;
		constructAndResize(serialized: string, videoIds: string[]): WatchedBitfieldInstance;
	}

	const watchedBitfield: WatchedBitfield;
	export default watchedBitfield;
}
