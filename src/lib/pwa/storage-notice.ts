/** `localStorage` key that remembers the one-time storage notice was dismissed. */
export const STORAGE_NOTICE_DISMISSED_KEY = 'notes.storageNoticeDismissed';

/**
 * Verbatim copy from the issue: it is the user's only explanation of where the
 * notes live, so it is not paraphrased.
 */
export const STORAGE_NOTICE_TEXT =
	"Your notes are stored only in this browser. Clearing browser data or using private mode will delete them. On iPhone/iPad, add the app to your Home Screen so Safari doesn't remove them after 7 days without use.";

/** The slice of `Storage` the notice needs, so tests can pass a fake. */
export type NoticeStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * `localStorage` can throw on access (Safari private mode, storage disabled by
 * policy), so it is resolved lazily and never assumed.
 */
function defaultStorage(): NoticeStorage | undefined {
	try {
		return globalThis.localStorage;
	} catch {
		return undefined;
	}
}

export function isStorageNoticeDismissed(
	storage: NoticeStorage | undefined = defaultStorage()
): boolean {
	try {
		return storage?.getItem(STORAGE_NOTICE_DISMISSED_KEY) === 'true';
	} catch {
		return false;
	}
}

export function dismissStorageNotice(storage: NoticeStorage | undefined = defaultStorage()): void {
	try {
		storage?.setItem(STORAGE_NOTICE_DISMISSED_KEY, 'true');
	} catch {
		// Best effort: a browser that refuses to persist this flag is the same
		// browser the notice warns about, and an exception must not break the app.
	}
}
