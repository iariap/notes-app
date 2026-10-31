/**
 * Cross-tab change feed for notes, on `BroadcastChannel('notes-app')`.
 *
 * Only *successful* writes are announced: the repository publishes after the
 * IndexedDB transaction commits, never before, so a receiver that reacts by
 * reloading always reads data that is already durable.
 */
import type { Note } from './types';

export const CHANNEL_NAME = 'notes-app';

export type RemoteChangeType = 'created' | 'updated' | 'deleted' | 'restored';

/** The payload sent on the channel. Structurally cloneable, nothing else. */
export interface RemoteChange {
	type: RemoteChangeType;
	id: string;
}

export type RemoteChangeHandler = (change: RemoteChange) => void;

export interface NotesSync {
	/** Announces a committed write. Never throws: sync must not fail a save. */
	post(change: RemoteChange): void;
	/** Subscribes to changes from other tabs. Returns an unsubscribe function. */
	onRemoteChange(handler: RemoteChangeHandler): () => void;
	/** Stops listening and releases the channel. */
	close(): void;
}

const CHANGE_TYPES: readonly RemoteChangeType[] = ['created', 'updated', 'deleted', 'restored'];

/** Rejects anything that is not a `RemoteChange` (other tabs may post junk). */
export function isRemoteChange(value: unknown): value is RemoteChange {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as { type?: unknown; id?: unknown };
	return (
		typeof candidate.id === 'string' &&
		candidate.id.length > 0 &&
		typeof candidate.type === 'string' &&
		(CHANGE_TYPES as readonly string[]).includes(candidate.type)
	);
}

function createChannel(name: string): BroadcastChannel | null {
	if (typeof BroadcastChannel === 'undefined') return null;
	try {
		return new BroadcastChannel(name);
	} catch {
		// Some privacy modes expose BroadcastChannel but refuse to create it.
		return null;
	}
}

export function createNotesSync(name: string = CHANNEL_NAME): NotesSync {
	const channel = createChannel(name);
	const handlers = new Set<RemoteChangeHandler>();

	channel?.addEventListener('message', (event: MessageEvent) => {
		if (!isRemoteChange(event.data)) return;
		for (const handler of [...handlers]) handler(event.data);
	});

	return {
		post(change) {
			if (!channel) return;
			try {
				// Sending the object as-is keeps the payload structured-cloneable and
				// identical to `RemoteChange`; a closed channel throws, and a failed
				// broadcast must never fail an already-committed write.
				channel.postMessage({ type: change.type, id: change.id });
			} catch {
				/* the write already landed; cross-tab delivery is best effort */
			}
		},
		onRemoteChange(handler) {
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},
		close() {
			handlers.clear();
			channel?.close();
		}
	};
}

/** Change that a note's body was replaced. */
export function isNoteChangeFor(change: RemoteChange, id: string): boolean {
	return change.id === id;
}

export type { Note };
