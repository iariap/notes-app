import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTOSAVE_DEBOUNCE_MS, NoteAutosave } from '$lib/notes/autosave.svelte';
import { StorageFullError } from '$lib/notes/types';

/**
 * The autosave queue, with fake timers and a hand-resolved save.
 *
 * Every assertion here is about a way text could be lost or overwritten:
 * a debounce that writes too early or too late, a flush that resolves before
 * the write lands, two writes overlapping, or a failure that swallows the text.
 */
interface ControlledSave {
	/** The save to hand to `NoteAutosave`. */
	save(body: string): Promise<void>;
	/** Calls the save received, in order, with the body of each call. */
	readonly calls: string[];
	/** Completes the oldest pending call. */
	resolveNext(): Promise<void>;
	/** Fails the oldest pending call. */
	rejectNext(error: unknown): Promise<void>;
	/** Number of saves started but not settled. */
	pending(): number;
	/** Longest number of simultaneous in-flight saves seen so far. */
	maxConcurrent(): number;
}

/** A save whose settlement the test controls, one call at a time. */
function controlledSave(): ControlledSave {
	const calls: string[] = [];
	const waiting: {
		resolve: () => void;
		reject: (error: unknown) => void;
	}[] = [];
	let inFlight = 0;
	let maxInFlight = 0;

	async function save(body: string): Promise<void> {
		calls.push(body);
		inFlight += 1;
		maxInFlight = Math.max(maxInFlight, inFlight);
		try {
			await new Promise<void>((resolve, reject) => {
				waiting.push({ resolve, reject });
			});
		} finally {
			inFlight -= 1;
		}
	}

	const shift = () => {
		const next = waiting.shift();
		if (!next) throw new Error('no save is pending: the component never wrote');
		return next;
	};

	return {
		save,
		calls,
		pending: () => inFlight,
		maxConcurrent: () => maxInFlight,
		async resolveNext() {
			shift().resolve();
			await nextMicrotask();
		},
		async rejectNext(error: unknown) {
			shift().reject(error);
			await nextMicrotask();
		}
	};
}

/** Lets the async loop advance one turn after a settlement. */
async function nextMicrotask(): Promise<void> {
	for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

/**
 * Fake timers only for the debounce. IndexedDB is not involved here (the save
 * is the stub), so nothing else needs a clock.
 */
beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('debounce', () => {
	it('writes nothing before 500 ms and exactly once after it', async () => {
		const save = controlledSave();
		const autosave = new NoteAutosave({ save: save.save });

		autosave.update('a');
		await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS - 1);
		expect(save.calls).toEqual([]);
		expect(autosave.status).toBe('pending');

		await vi.advanceTimersByTimeAsync(1);
		expect(save.calls).toEqual(['a']);
		expect(autosave.status).toBe('saving');

		await save.resolveNext();
		expect(autosave.status).toBe('saved');
	});

	it('writes only the latest text when typing continues inside the window', async () => {
		const save = controlledSave();
		const autosave = new NoteAutosave({ save: save.save });

		autosave.update('h');
		await vi.advanceTimersByTimeAsync(300);
		autosave.update('he');
		await vi.advanceTimersByTimeAsync(300);
		autosave.update('hello');
		await vi.advanceTimersByTimeAsync(300);

		// The first two keystrokes never reached storage: the timer restarted.
		expect(save.calls).toEqual([]);

		await vi.advanceTimersByTimeAsync(200);
		expect(save.calls).toEqual(['hello']);
		await save.resolveNext();
	});

	it('restarts the 500 ms window on every keystroke', async () => {
		const save = controlledSave();
		const autosave = new NoteAutosave({ save: save.save });

		autosave.update('one');
		await vi.advanceTimersByTimeAsync(499);
		autosave.update('one!');
		await vi.advanceTimersByTimeAsync(499);
		expect(save.calls).toEqual([]);

		await vi.advanceTimersByTimeAsync(1);
		expect(save.calls).toEqual(['one!']);
		await save.resolveNext();
	});

	it('writes immediately when asked, without waiting for the debounce', async () => {
		const save = controlledSave();
		const autosave = new NoteAutosave({ save: save.save });

		autosave.update('now', { immediate: true });
		await nextMicrotask();

		expect(save.calls).toEqual(['now']);
		await save.resolveNext();
		expect(autosave.status).toBe('saved');
	});
});

describe('flush', () => {
	it('writes a still-pending body at once and resolves after it landed', async () => {
		const save = controlledSave();
		const autosave = new NoteAutosave({ save: save.save });

		autosave.update('typed but not yet debounced');
		const flushed = autosave.flush();
		await nextMicrotask();

		// The write started without the timer having fired.
		expect(save.calls).toEqual(['typed but not yet debounced']);

		// And the flush is a barrier: it has not resolved while the write is open.
		let done = false;
		void flushed.then(() => {
			done = true;
		});
		await nextMicrotask();
		expect(done).toBe(false);

		await save.resolveNext();
		await flushed;
		expect(done).toBe(true);
	});

	it('resolves without writing when nothing is pending', async () => {
		const save = controlledSave();
		const autosave = new NoteAutosave({ save: save.save });

		await autosave.flush();

		expect(save.calls).toEqual([]);
		expect(autosave.status).toBe('idle');
	});

	it('does not let the debounce write again after a flush', async () => {
		const save = controlledSave();
		const autosave = new NoteAutosave({ save: save.save });

		autosave.update('once');
		const flushed = autosave.flush();
		await save.resolveNext();
		await flushed;

		// The old timer would have fired here; it was cleared by the flush.
		await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);
		expect(save.calls).toEqual(['once']);
	});
});

describe('single in-flight write', () => {
	it('never runs two saves at once, even when a flush races a debounce', async () => {
		const save = controlledSave();
		const autosave = new NoteAutosave({ save: save.save });

		autosave.update('first');
		await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
		expect(save.calls).toEqual(['first']);

		// A second body arrives while the first write is still open, and a flush
		// (the "user is leaving" path) asks to write it right now.
		autosave.update('second');
		const flushed = autosave.flush();
		await nextMicrotask();

		// Still one call: the flush joined the in-flight write instead of
		// starting a second one, which would let the older body land last.
		expect(save.calls).toEqual(['first']);
		expect(save.maxConcurrent()).toBe(1);

		// Completing the first write lets the queue take the newer body.
		await save.resolveNext();
		expect(save.calls).toEqual(['first', 'second']);
		expect(save.maxConcurrent()).toBe(1);

		await save.resolveNext();
		await flushed;
		expect(autosave.status).toBe('saved');
	});

	it('coalesces several keystrokes during one write into a single follow-up', async () => {
		const save = controlledSave();
		const autosave = new NoteAutosave({ save: save.save });

		autosave.update('v1');
		await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
		expect(save.calls).toEqual(['v1']);

		autosave.update('v2');
		autosave.update('v3');
		autosave.update('v4');
		await save.resolveNext();
		await nextMicrotask();

		// One follow-up with the newest text — not three writes, one per keystroke.
		expect(save.calls).toEqual(['v1', 'v4']);
		expect(save.maxConcurrent()).toBe(1);

		await save.resolveNext();
		await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
		expect(save.calls).toEqual(['v1', 'v4']);
	});

	it('keeps a 20-keystroke burst to at most one write in flight', async () => {
		const save = controlledSave();
		const autosave = new NoteAutosave({ save: save.save });

		for (let index = 1; index <= 20; index += 1) {
			autosave.update('x'.repeat(index));
			await vi.advanceTimersByTimeAsync(60);
		}
		// Settle whatever the loop started, without ever awaiting two at once.
		while (save.pending() > 0) await save.resolveNext();
		await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
		while (save.pending() > 0) await save.resolveNext();

		expect(save.maxConcurrent()).toBe(1);
		expect(save.calls.at(-1)).toBe('x'.repeat(20));
	});
});

describe('status', () => {
	it('is idle, pending, saving, saved as the write moves through its states', async () => {
		const save = controlledSave();
		const autosave = new NoteAutosave({ save: save.save });
		const seen: string[] = [];
		const record = () => seen.push(autosave.status);

		record();
		autosave.update('a');
		record();
		await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
		record();
		await save.resolveNext();
		record();

		expect(seen).toEqual(['idle', 'pending', 'saving', 'saved']);
	});

	it('reports unsaved changes while pending, in flight and after a failure', async () => {
		const save = controlledSave();
		const autosave = new NoteAutosave({ save: save.save });

		expect(autosave.hasUnsavedChanges).toBe(false);
		autosave.update('a');
		expect(autosave.hasUnsavedChanges).toBe(true);
		await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
		expect(autosave.hasUnsavedChanges).toBe(true);
	});

	it('reports no unsaved changes once a save succeeded', async () => {
		const save = controlledSave();
		const autosave = new NoteAutosave({ save: save.save });

		autosave.update('a');
		const flushed = autosave.flush();
		await save.resolveNext();
		await flushed;

		expect(autosave.hasUnsavedChanges).toBe(false);
		expect(autosave.status).toBe('saved');
	});
});

describe('failure', () => {
	it('keeps the text, reports the typed error and retries on demand', async () => {
		const save = controlledSave();
		const autosave = new NoteAutosave({ save: save.save });

		autosave.update('precious text');
		await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
		await save.rejectNext(new StorageFullError());

		expect(autosave.status).toBe('error');
		expect(autosave.error).toBeInstanceOf(StorageFullError);
		// The text is still "unsaved": a remote update must not overwrite it.
		expect(autosave.hasUnsavedChanges).toBe(true);

		// Retry writes the same text again, untouched.
		const retried = autosave.retry();
		await nextMicrotask();
		expect(save.calls).toEqual(['precious text', 'precious text']);
		await save.resolveNext();
		await retried;

		expect(autosave.status).toBe('saved');
		expect(autosave.error).toBeNull();
	});

	it('retries by itself on the next keystroke after a failure', async () => {
		const save = controlledSave();
		const autosave = new NoteAutosave({ save: save.save });

		autosave.update('v1');
		await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
		await save.rejectNext(new StorageFullError());

		autosave.update('v2');
		await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
		expect(save.calls).toEqual(['v1', 'v2']);
		await save.resolveNext();

		expect(autosave.status).toBe('saved');
		expect(autosave.error).toBeNull();
	});

	it('does not loop retrying a failure on its own', async () => {
		const save = controlledSave();
		const autosave = new NoteAutosave({ save: save.save });

		autosave.update('v1');
		await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
		await save.rejectNext(new StorageFullError());
		await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 4);

		// Exactly one attempt: no busy loop against a full disk.
		expect(save.calls).toEqual(['v1']);
		expect(save.pending()).toBe(0);
	});

	it('retries the failed text when a flush happens, since that is the last chance', async () => {
		const save = controlledSave();
		const autosave = new NoteAutosave({ save: save.save });

		autosave.update('still only on screen');
		await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
		await save.rejectNext(new StorageFullError());
		expect(autosave.status).toBe('error');

		// Leaving the note: the flush must try again, not give up on the text.
		const flushed = autosave.flush();
		await nextMicrotask();
		expect(save.calls).toEqual(['still only on screen', 'still only on screen']);
		await save.resolveNext();
		await flushed;

		expect(autosave.status).toBe('saved');
		expect(autosave.error).toBeNull();
	});

	it('normalizes an untyped failure so the UI always has a message', async () => {
		const autosave = new NoteAutosave({
			save: async () => {
				throw new Error('boom');
			}
		});

		autosave.update('a');
		await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);

		expect(autosave.error?.message).toBe('boom');
		expect(autosave.status).toBe('error');
	});

	it('clears the error on the next successful write', async () => {
		let attempt = 0;
		const autosave = new NoteAutosave({
			save: async () => {
				attempt += 1;
				if (attempt === 1) throw new StorageFullError();
			}
		});

		autosave.update('a');
		await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
		expect(autosave.status).toBe('error');

		await autosave.retry();
		expect(autosave.error).toBeNull();
		expect(autosave.status).toBe('saved');
	});
});

describe('stop', () => {
	it('drops the pending write without calling save', async () => {
		const save = controlledSave();
		const autosave = new NoteAutosave({ save: save.save });

		autosave.update('never mind');
		autosave.stop();
		await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);

		expect(save.calls).toEqual([]);
		expect(autosave.hasUnsavedChanges).toBe(false);
	});
});

describe('custom debounce', () => {
	it('honours an injected debounce, which the component tests rely on', async () => {
		const save = controlledSave();
		const autosave = new NoteAutosave({ save: save.save, debounceMs: 50 });

		autosave.update('a');
		await vi.advanceTimersByTimeAsync(49);
		expect(save.calls).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(save.calls).toEqual(['a']);
		await save.resolveNext();
	});
});
