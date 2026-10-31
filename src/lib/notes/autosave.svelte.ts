/**
 * Debounced autosave for a single note (#7).
 *
 * The product promise is that typing is never lost, so the interesting part of
 * this module is not the timer: it is the queue. Three rules hold at all times,
 * and every rule exists because there is a way to break it:
 *
 * 1. **One write in flight, ever.** `#drain` is guarded by `#inFlight`, so a
 *    second save can never start while the first is awaiting storage. Two
 *    concurrent `put` calls on the same record would let the older payload
 *    land last.
 * 2. **The newest text wins.** A keystroke that arrives while a save is in
 *    flight sets `#dirty` again; the loop then saves the *current* `#latest`,
 *    not the body captured when the save started.
 * 3. **A flush is a barrier.** `flush()` awaits the entire drain (including a
 *    round queued during it), which is what makes "flush before leaving"
 *    actually mean "the text is on disk before we go".
 *
 * A failure stops the loop and keeps the status at `error`; the text is not
 * touched, and the next edit (or `retry()`) starts a new attempt.
 */
import { normalizeError } from './notes.svelte';

/** How long a keystroke waits before it is written. */
export const AUTOSAVE_DEBOUNCE_MS = 500;

export type AutosaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

/** Writes one body. The caller decides create-vs-update. */
export type AutosaveSave = (body: string) => Promise<void>;

export interface AutosaveOptions {
	/** Persists `body`; rejects with a typed error the UI can show verbatim. */
	save: AutosaveSave;
	/** Override for tests; production always uses `AUTOSAVE_DEBOUNCE_MS`. */
	debounceMs?: number;
}

export class NoteAutosave {
	/** `pending` and `saving` both read as "Saving…" in the UI. */
	status = $state<AutosaveStatus>('idle');
	/** The last failure, typed; cleared by the next successful write. */
	error = $state<Error | null>(null);

	readonly #save: AutosaveSave;
	readonly #debounceMs: number;
	/** Newest text known to this editor, saved or not. */
	#latest = '';
	/** There is text that storage does not have yet. */
	#dirty = false;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#inFlight: Promise<void> | null = null;

	constructor(options: AutosaveOptions) {
		this.#save = options.save;
		this.#debounceMs = options.debounceMs ?? AUTOSAVE_DEBOUNCE_MS;
	}

	/**
	 * `true` while the editor holds text that storage does not: waiting on the
	 * debounce, in flight, or failed. This is what the editor consults before
	 * adopting a body written by another tab (last write wins).
	 *
	 * A write in flight counts, even though `#dirty` was cleared to start it:
	 * adopting a remote body mid-write would put the other tab's text under the
	 * user's cursor and then let the write land afterwards, which is neither
	 * last-write-wins nor the local text.
	 */
	get hasUnsavedChanges(): boolean {
		return this.#dirty || this.#inFlight !== null || this.status === 'error';
	}

	/** `true` while a write is awaiting storage. */
	get isSaving(): boolean {
		return this.#inFlight !== null;
	}

	/**
	 * Records a keystroke. Debounced unless `immediate` is set, which the editor
	 * uses for the very first character of a new note so its URL becomes real
	 * (and its row appears in the list) without waiting half a second.
	 */
	update(body: string, options: { immediate?: boolean } = {}): void {
		this.#latest = body;
		this.#dirty = true;
		this.status = 'pending';
		this.#clearTimer();
		if (options.immediate) {
			void this.#drain();
			return;
		}
		this.#timer = setTimeout(() => {
			this.#timer = null;
			void this.#drain();
		}, this.#debounceMs);
	}

	/**
	 * Writes everything pending right now and resolves once storage has it.
	 *
	 * Called on navigation, tab hide, page hide and destroy, so it must never
	 * reject: a save failure is reported through `error`/`status`, and leaving
	 * the note must not depend on it succeeding.
	 *
	 * A previous failure counts as pending: the text is still unsaved, and this
	 * is the last moment it can be written before the editor goes away, so the
	 * flush re-attempts it rather than leaving it only on screen.
	 */
	async flush(): Promise<void> {
		this.#clearTimer();
		if (this.status === 'error') this.#dirty = true;
		await this.#drain();
	}

	/** Re-attempts a failed write with the text still in the editor. */
	async retry(): Promise<void> {
		await this.flush();
	}

	/** Drops the pending write without touching the text (note gone elsewhere). */
	stop(): void {
		this.#clearTimer();
		this.#dirty = false;
	}

	#clearTimer(): void {
		if (this.#timer !== null) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
	}

	/**
	 * Runs one drain, or joins the one already running. Joining is what makes
	 * `flush()` a barrier: the joined promise only resolves when the loop,
	 * including any round queued during it, has finished.
	 */
	async #drain(): Promise<void> {
		const running = this.#inFlight;
		if (running !== null) return await running;
		const run = this.#run();
		this.#inFlight = run;
		try {
			await run;
		} finally {
			this.#inFlight = null;
		}
	}

	async #run(): Promise<void> {
		try {
			while (this.#dirty) {
				// Cleared *before* the await: anything typed while the write is in
				// flight sets it again and the loop takes another turn with the
				// newer body. Nothing is dropped and nothing overlaps.
				this.#dirty = false;
				const body = this.#latest;
				this.status = 'saving';
				await this.#save(body);
				this.error = null;
				if (!this.#dirty) this.status = 'saved';
			}
		} catch (error) {
			// The text stays exactly where it is; the caller shows the alert.
			this.error = normalizeError(error);
			this.status = 'error';
		}
	}
}
