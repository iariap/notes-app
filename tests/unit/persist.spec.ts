import { describe, expect, it, vi } from 'vitest';
import { requestPersistentStorage } from '$lib/pwa/persist';

describe('requestPersistentStorage', () => {
	it('asks the browser to persist and resolves with the grant', async () => {
		const persist = vi.fn(async () => true);

		await expect(requestPersistentStorage({ persist })).resolves.toBe(true);
		expect(persist).toHaveBeenCalledOnce();
	});

	it('resolves with a denial instead of rejecting', async () => {
		const persist = vi.fn(async () => false);

		await expect(requestPersistentStorage({ persist })).resolves.toBe(false);
	});

	it('does nothing when the API is missing', async () => {
		await expect(requestPersistentStorage(undefined)).resolves.toBeUndefined();
		await expect(requestPersistentStorage({})).resolves.toBeUndefined();
	});

	it('does not reject when the browser throws', async () => {
		const persist = vi.fn(async () => {
			throw new Error('not allowed');
		});

		await expect(requestPersistentStorage({ persist })).resolves.toBeUndefined();
	});

	it('defaults to navigator.storage', async () => {
		const persist = vi.fn(async () => true);
		vi.stubGlobal('navigator', { storage: { persist } });

		await expect(requestPersistentStorage()).resolves.toBe(true);
		expect(persist).toHaveBeenCalledOnce();

		vi.unstubAllGlobals();
	});
});
