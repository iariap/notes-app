import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	dismissStorageNotice,
	isStorageNoticeDismissed,
	STORAGE_NOTICE_DISMISSED_KEY,
	STORAGE_NOTICE_TEXT,
	type NoticeStorage
} from '$lib/pwa/storage-notice';

/** Minimal in-memory `localStorage`; `localStorage` itself is stubbed per test. */
function fakeStorage(initial: Record<string, string> = {}) {
	const entries = new Map(Object.entries(initial));
	const storage: NoticeStorage = {
		getItem: (key) => entries.get(key) ?? null,
		setItem: (key, value) => void entries.set(key, value)
	};
	return { storage, entries };
}

describe('storage notice', () => {
	it('copies the issue text verbatim, iPhone/iPad sentence included', () => {
		expect(STORAGE_NOTICE_TEXT).toBe(
			"Your notes are stored only in this browser. Clearing browser data or using private mode will delete them. On iPhone/iPad, add the app to your Home Screen so Safari doesn't remove them after 7 days without use."
		);
	});

	it('persists the dismissal under the agreed key', () => {
		const { storage, entries } = fakeStorage();

		dismissStorageNotice(storage);

		expect(STORAGE_NOTICE_DISMISSED_KEY).toBe('notes.storageNoticeDismissed');
		expect(entries.get('notes.storageNoticeDismissed')).toBe('true');
	});

	it('is not dismissed until it is dismissed', () => {
		const { storage } = fakeStorage();

		expect(isStorageNoticeDismissed(storage)).toBe(false);

		dismissStorageNotice(storage);

		expect(isStorageNoticeDismissed(storage)).toBe(true);
	});

	it('treats any stored value other than "true" as not dismissed', () => {
		const { storage } = fakeStorage({ [STORAGE_NOTICE_DISMISSED_KEY]: 'yes' });

		expect(isStorageNoticeDismissed(storage)).toBe(false);
	});

	describe('when the browser refuses storage', () => {
		const throwing: NoticeStorage = {
			getItem: () => {
				throw new Error('SecurityError: storage disabled');
			},
			setItem: () => {
				throw new Error('SecurityError: storage disabled');
			}
		};

		it('reads as not dismissed instead of throwing', () => {
			expect(isStorageNoticeDismissed(throwing)).toBe(false);
		});

		it('swallows a failed write so the app keeps working', () => {
			expect(() => dismissStorageNotice(throwing)).not.toThrow();
		});
	});

	it('falls back to the real localStorage by default', () => {
		const { entries } = fakeStorage();
		const getItem = vi.fn((key: string) => entries.get(key) ?? null);
		const setItem = vi.fn((key: string, value: string) => void entries.set(key, value));
		vi.stubGlobal('localStorage', { getItem, setItem });

		expect(isStorageNoticeDismissed()).toBe(false);
		dismissStorageNotice();

		expect(getItem).toHaveBeenCalledWith(STORAGE_NOTICE_DISMISSED_KEY);
		expect(setItem).toHaveBeenCalledWith(STORAGE_NOTICE_DISMISSED_KEY, 'true');
		expect(isStorageNoticeDismissed()).toBe(true);

		vi.unstubAllGlobals();
	});

	describe('without any localStorage at all', () => {
		beforeEach(() => {
			vi.stubGlobal('localStorage', undefined);
		});

		it('does not throw and reports not dismissed', () => {
			expect(isStorageNoticeDismissed()).toBe(false);
			expect(() => dismissStorageNotice()).not.toThrow();
			vi.unstubAllGlobals();
		});
	});

	it('survives a browser that throws on merely accessing localStorage', () => {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
		Object.defineProperty(globalThis, 'localStorage', {
			configurable: true,
			get() {
				throw new Error('SecurityError: storage disabled');
			}
		});

		try {
			expect(isStorageNoticeDismissed()).toBe(false);
			expect(() => dismissStorageNotice()).not.toThrow();
		} finally {
			if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
			else Reflect.deleteProperty(globalThis, 'localStorage');
		}
	});
});
