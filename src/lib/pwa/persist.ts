/**
 * The slice of `navigator.storage` this module needs. Narrower than
 * `StorageManager` on purpose: callers (and tests) only ever provide `persist`,
 * and requiring the full interface would force casts that hide the real
 * contract.
 */
export type PersistentStorage = Partial<Pick<StorageManager, 'persist'>>;

/**
 * Asks the browser to keep this origin's storage (IndexedDB) out of eviction.
 *
 * Nothing user-facing happens either way: the browser may deny the request
 * silently and the one-time storage notice already explains the risk. Returns
 * `undefined` when the API is absent (older Safari, a locked-down context) and
 * the grant result when it exists.
 */
export async function requestPersistentStorage(
	storage: PersistentStorage | undefined = globalThis.navigator?.storage
): Promise<boolean | undefined> {
	if (typeof storage?.persist !== 'function') return undefined;
	try {
		return await storage.persist();
	} catch {
		return undefined;
	}
}
