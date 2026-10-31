/**
 * Test-only `IDBFactory` wrappers that inject failures real in-memory IndexedDB
 * never produces.
 *
 * Each wrapper delegates to a real factory and patches only the methods named in
 * `FailureOptions` on the database it produced. Returning a rejected promise is
 * enough to model a failed request: `idb` only wraps actual `IDBRequest`
 * instances, so the rejection reaches the repository exactly as a failed request
 * would, and the repository's own write path aborts the transaction.
 *
 * Patched properties are `configurable` and `writable` because `idb` proxies
 * these objects and must be able to return the wrapped function.
 */
import { IDBFactory } from 'fake-indexeddb';

export type StoreMethod = 'add' | 'put' | 'delete' | 'get' | 'getAll';

export interface FailureOptions {
	/** Store methods to fail, mapped to the thrown value (usually a DOMException). */
	methods: Partial<Record<StoreMethod, unknown>>;
	/** Store to instrument. Defaults to `notes`. */
	storeName?: string;
	/** Receives the name of every method that was short-circuited, in order. */
	calls?: string[];
}

export const NOTES_STORE_NAME = 'notes';

/** A fresh factory whose configured store methods reject with the given values. */
export function failingFactory(
	options: FailureOptions,
	inner: IDBFactory = new IDBFactory()
): IDBFactory {
	const factory = new IDBFactory();
	const storeName = options.storeName ?? NOTES_STORE_NAME;

	Object.defineProperty(factory, 'open', {
		configurable: true,
		writable: true,
		value: (name: string, version?: number) => {
			const request = inner.open(name, version);
			// Registered before `idb` sees the request, so the database is already
			// instrumented by the time the open promise resolves.
			request.addEventListener('success', () => instrument(request.result, storeName, options));
			return request;
		}
	});

	return factory;
}

/** Convenience: fail one method with a `DOMException` of the given name. */
export function failingWith(
	method: StoreMethod,
	errorName: string,
	inner?: IDBFactory,
	storeName?: string
): IDBFactory {
	return failingFactory(
		{ methods: { [method]: new DOMException(`injected ${errorName}`, errorName) }, storeName },
		inner
	);
}

function instrument(database: IDBDatabase, storeName: string, options: FailureOptions): void {
	const originalTransaction = database.transaction.bind(database);
	Object.defineProperty(database, 'transaction', {
		configurable: true,
		writable: true,
		value: (names: string | string[], mode?: IDBTransactionMode) => {
			const transaction = originalTransaction(names, mode);
			const originalObjectStore = transaction.objectStore.bind(transaction);
			Object.defineProperty(transaction, 'objectStore', {
				configurable: true,
				writable: true,
				value: (requested: string) => {
					const store = originalObjectStore(requested);
					if (requested === storeName) instrumentStore(store, options);
					return store;
				}
			});
			return transaction;
		}
	});
}

function instrumentStore(store: IDBObjectStore, options: FailureOptions): void {
	for (const [method, thrown] of Object.entries(options.methods) as [StoreMethod, unknown][]) {
		Object.defineProperty(store, method, {
			configurable: true,
			writable: true,
			value: () => {
				options.calls?.push(method);
				return Promise.reject(thrown);
			}
		});
	}
}
