import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StorageNotice from '../../src/lib/components/StorageNotice.svelte';
import {
	STORAGE_NOTICE_DISMISSED_KEY,
	STORAGE_NOTICE_TEXT
} from '../../src/lib/pwa/storage-notice';

/**
 * jsdom in this Node version leaves `localStorage` undefined (Node's own
 * experimental `localStorage` global only exists with `--localstorage-file`),
 * so each test installs a real in-memory one. The component reads the global
 * through `storage-notice.ts`, exactly as it does in a browser.
 */
function installLocalStorage() {
	const entries = new Map<string, string>();
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => entries.get(key) ?? null,
		setItem: (key: string, value: string) => void entries.set(key, value),
		removeItem: (key: string) => void entries.delete(key),
		clear: () => entries.clear()
	});
	return entries;
}

let entries: Map<string, string>;

beforeEach(() => {
	entries = installLocalStorage();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('StorageNotice', () => {
	it('shows the notice text verbatim on a first visit', () => {
		render(StorageNotice);

		expect(screen.getByTestId('storage-notice')).toBeInTheDocument();
		expect(screen.getByText(STORAGE_NOTICE_TEXT)).toBeInTheDocument();
	});

	it('offers an "OK, got it" button that dismisses it', async () => {
		const onDismiss = vi.fn();
		render(StorageNotice, { props: { onDismiss } });

		await fireEvent.click(screen.getByRole('button', { name: 'OK, got it' }));

		expect(screen.queryByTestId('storage-notice')).not.toBeInTheDocument();
		expect(onDismiss).toHaveBeenCalledOnce();
	});

	it('persists the dismissal so a later mount stays quiet', async () => {
		const { unmount } = render(StorageNotice);
		await fireEvent.click(screen.getByRole('button', { name: 'OK, got it' }));
		unmount();

		expect(entries.get(STORAGE_NOTICE_DISMISSED_KEY)).toBe('true');

		render(StorageNotice);
		expect(screen.queryByTestId('storage-notice')).not.toBeInTheDocument();
	});

	it('stays hidden when a previous visit already dismissed it', () => {
		entries.set(STORAGE_NOTICE_DISMISSED_KEY, 'true');

		render(StorageNotice);

		expect(screen.queryByTestId('storage-notice')).not.toBeInTheDocument();
	});

	it('is announced as an alert so it is not silent to screen readers', () => {
		render(StorageNotice);

		expect(screen.getByRole('alert')).toHaveTextContent(STORAGE_NOTICE_TEXT);
	});

	it('gives the dismiss button a 44 px touch target', () => {
		render(StorageNotice);

		// `h-11` is 44 px; the real box is measured in the Playwright specs.
		expect(screen.getByRole('button', { name: 'OK, got it' })).toHaveClass('h-11');
	});

	it('still renders when storage throws (private mode)', () => {
		vi.stubGlobal('localStorage', {
			getItem: () => {
				throw new Error('SecurityError');
			},
			setItem: () => {
				throw new Error('SecurityError');
			}
		});

		render(StorageNotice);

		expect(screen.getByTestId('storage-notice')).toBeInTheDocument();
	});
});
