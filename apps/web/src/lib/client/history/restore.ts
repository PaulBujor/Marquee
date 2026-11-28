/**
 * Undoing a rewind — the one place a "past" state is written back into the present.
 *
 * Rewinding is a **forward write**. The event log is append-only and every device replays it with
 * last-writer-wins on `clientCreatedAt`, so "put the library back the way it was at 6pm" is done by
 * emitting the events that make *now* look like *then*. Nothing is deleted from the log: deletion
 * would need a compaction protocol (an offline device could re-push what was removed) and would
 * break the LWW determinism the whole sync rests on. The compensating events are stamped now, so
 * they win the merge and reach the user's other devices — and Stremio — like any other change.
 */
import { recordEvents } from '#lib/client/idb/index.js';
import { compensatingEvents, type TitleDiff } from '#lib/sync/history.js';

/**
 * Writes the compensating events for the given title diffs through the normal event path
 * (outbox + optimistic projection). Returns how many events were written; the caller nudges sync.
 */
export async function restoreTitles(diffs: readonly TitleDiff[]): Promise<number> {
	const specs = compensatingEvents(diffs);
	await recordEvents(specs);
	return specs.length;
}
