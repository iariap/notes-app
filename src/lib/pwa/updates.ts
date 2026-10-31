import { registerSW } from 'virtual:pwa-register';
import { toast } from 'svelte-sonner';

/** Copy the toast shows when a newer build is waiting to take over. */
export const UPDATE_TOAST_MESSAGE = 'A new version is available';
export const UPDATE_TOAST_ACTION = 'Reload';
/** Fixed id: repeated prompts from repeated checks collapse into one toast. */
export const UPDATE_TOAST_ID = 'notes-update';

type RegisterUpdatesOptions = {
	/** Injected in tests; defaults to the toast from `svelte-sonner`. */
	notify?: (onReload: () => void) => void;
	/** Injected in tests; defaults to the plugin's `registerSW`. */
	register?: typeof registerSW;
};

let registered = false;

function showUpdateToast(onReload: () => void): void {
	toast(UPDATE_TOAST_MESSAGE, {
		id: UPDATE_TOAST_ID,
		// A version notice is not a transient status: it stays until the user
		// acts on it or dismisses it, so a reload never surprises them.
		duration: Infinity,
		action: { label: UPDATE_TOAST_ACTION, onClick: onReload }
	});
}

/**
 * Registers the service worker built by `@vite-pwa/sveltekit` (generateSW,
 * `registerType: 'prompt'`) and turns a waiting worker into a toast.
 *
 * Nothing reloads by itself: `registerSW` is called without `immediate` and
 * with `prompt` semantics, so the only reload is the one the user asks for by
 * pressing "Reload". That is the whole point — a reload while someone is
 * typing in the editor would lose the in-flight text.
 */
export function registerServiceWorkerUpdates({
	notify = showUpdateToast,
	register = registerSW
}: RegisterUpdatesOptions = {}): void {
	if (registered) return;
	registered = true;

	const updateServiceWorker = register({
		onNeedRefresh() {
			notify(() => {
				void updateServiceWorker(true);
			});
		},
		onRegisterError(error) {
			// No user-facing message: the app works without a service worker,
			// it just isn't installable/offline. The log is for whoever debugs it.
			console.error('Service worker registration failed', error);
		}
	});
}

/** Test seam: lets each test start from a clean "not registered" state. */
export function resetServiceWorkerUpdatesForTests(): void {
	registered = false;
}
