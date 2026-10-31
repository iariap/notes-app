import { describe, it, expect, afterEach } from 'vitest';
import { CHANNEL_NAME, createNotesSync, isNoteChangeFor, isRemoteChange } from '$lib/notes/sync';

const open: BroadcastChannel[] = [];

afterEach(() => {
	while (open.length > 0) open.pop()?.close();
});

/** A second channel on the same name, standing in for another tab. */
function remoteChannel(name = CHANNEL_NAME): BroadcastChannel {
	const channel = new BroadcastChannel(name);
	open.push(channel);
	return channel;
}

function collect(channel: BroadcastChannel): unknown[] {
	const seen: unknown[] = [];
	channel.addEventListener('message', (event: MessageEvent) => seen.push(event.data));
	return seen;
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error('timed out waiting for condition');
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe('channel name', () => {
	it('uses notes-app', () => {
		expect(CHANNEL_NAME).toBe('notes-app');
	});
});

describe('posting', () => {
	it('delivers each change type to another channel on the same name', async () => {
		const sync = createNotesSync();
		const remote = remoteChannel();
		const seen = collect(remote);

		sync.post({ type: 'created', id: 'a' });
		sync.post({ type: 'updated', id: 'a' });
		sync.post({ type: 'deleted', id: 'a' });
		sync.post({ type: 'restored', id: 'a' });
		await waitFor(() => seen.length === 4);

		expect(seen).toEqual([
			{ type: 'created', id: 'a' },
			{ type: 'updated', id: 'a' },
			{ type: 'deleted', id: 'a' },
			{ type: 'restored', id: 'a' }
		]);
		sync.close();
	});

	it('does not deliver to the channel that posted', async () => {
		const sync = createNotesSync();
		const own: unknown[] = [];
		sync.onRemoteChange((change) => own.push(change));

		sync.post({ type: 'created', id: 'a' });
		await new Promise((resolve) => setTimeout(resolve, 30));

		// BroadcastChannel never echoes to the sender; a tab must not treat its own
		// write as a remote change.
		expect(own).toEqual([]);
		sync.close();
	});

	it('does not throw when the channel cannot be created', () => {
		const saved = globalThis.BroadcastChannel;
		Object.defineProperty(globalThis, 'BroadcastChannel', {
			value: undefined,
			configurable: true
		});
		try {
			const sync = createNotesSync();
			expect(() => sync.post({ type: 'created', id: 'a' })).not.toThrow();
			expect(sync.onRemoteChange(() => {})).toBeTypeOf('function');
			sync.close();
		} finally {
			Object.defineProperty(globalThis, 'BroadcastChannel', { value: saved, configurable: true });
		}
	});

	it('survives a constructor that throws', () => {
		const saved = globalThis.BroadcastChannel;
		function Throwing(): never {
			throw new DOMException('not allowed', 'SecurityError');
		}
		Object.defineProperty(globalThis, 'BroadcastChannel', {
			value: Throwing,
			configurable: true
		});
		try {
			const sync = createNotesSync();
			expect(() => sync.post({ type: 'created', id: 'a' })).not.toThrow();
			expect(() => sync.close()).not.toThrow();
		} finally {
			Object.defineProperty(globalThis, 'BroadcastChannel', { value: saved, configurable: true });
		}
	});
});

describe('onRemoteChange', () => {
	it('delivers changes posted by another channel', async () => {
		const sync = createNotesSync();
		const seen: unknown[] = [];
		sync.onRemoteChange((change) => seen.push(change));
		const remote = remoteChannel();

		remote.postMessage({ type: 'updated', id: 'note-1' });
		await waitFor(() => seen.length === 1);

		expect(seen).toEqual([{ type: 'updated', id: 'note-1' }]);
		sync.close();
	});

	it('returns an unsubscribe function that stops delivery', async () => {
		const sync = createNotesSync();
		const seen: unknown[] = [];
		const unsubscribe = sync.onRemoteChange((change) => seen.push(change));
		const remote = remoteChannel();

		remote.postMessage({ type: 'created', id: 'a' });
		await waitFor(() => seen.length === 1);

		unsubscribe();
		remote.postMessage({ type: 'created', id: 'b' });
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(seen).toEqual([{ type: 'created', id: 'a' }]);
		sync.close();
	});

	it('supports several independent subscribers', async () => {
		const sync = createNotesSync();
		const first: unknown[] = [];
		const second: unknown[] = [];
		sync.onRemoteChange((change) => first.push(change));
		sync.onRemoteChange((change) => second.push(change));
		const remote = remoteChannel();

		remote.postMessage({ type: 'deleted', id: 'a' });
		await waitFor(() => first.length === 1 && second.length === 1);

		expect(first).toEqual([{ type: 'deleted', id: 'a' }]);
		expect(second).toEqual([{ type: 'deleted', id: 'a' }]);
		sync.close();
	});

	it('ignores malformed messages from other tabs', async () => {
		const sync = createNotesSync();
		const seen: unknown[] = [];
		sync.onRemoteChange((change) => seen.push(change));
		const remote = remoteChannel();

		for (const junk of [
			null,
			42,
			'text',
			{},
			{ type: 'created' },
			{ id: 'a' },
			{ type: 'nope', id: 'a' }
		]) {
			remote.postMessage(junk);
		}
		remote.postMessage({ type: 'created', id: 'valid' });
		await waitFor(() => seen.length === 1);

		expect(seen).toEqual([{ type: 'created', id: 'valid' }]);
		sync.close();
	});

	it('stops delivering after close', async () => {
		const sync = createNotesSync();
		const seen: unknown[] = [];
		sync.onRemoteChange((change) => seen.push(change));
		const remote = remoteChannel();

		sync.close();
		remote.postMessage({ type: 'created', id: 'a' });
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(seen).toEqual([]);
	});
});

describe('isRemoteChange', () => {
	it('accepts the four change types', () => {
		for (const type of ['created', 'updated', 'deleted', 'restored'] as const) {
			expect(isRemoteChange({ type, id: 'a' })).toBe(true);
		}
	});

	it('rejects anything else', () => {
		expect(isRemoteChange(undefined)).toBe(false);
		expect(isRemoteChange(null)).toBe(false);
		expect(isRemoteChange({ type: 'created', id: '' })).toBe(false);
		expect(isRemoteChange({ type: 'created', id: 1 })).toBe(false);
		expect(isRemoteChange({ type: 'other', id: 'a' })).toBe(false);
	});
});

describe('isNoteChangeFor', () => {
	it('matches on id', () => {
		expect(isNoteChangeFor({ type: 'updated', id: 'a' }, 'a')).toBe(true);
		expect(isNoteChangeFor({ type: 'updated', id: 'a' }, 'b')).toBe(false);
	});
});
