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
	/**
	 * Whether a service worker is currently controlling this page — i.e. whether
	 * there is a running version that a waiting worker could replace.
	 *
	 * Injected so the decision is testable; defaults to
	 * `navigator.serviceWorker.controller`.
	 */
	isControlled?: () => boolean;
};

let registered = false;

/**
 * True when the page is running a worker, so "a new version" is a real change
 * from the one on screen.
 *
 * A first visit has no controller: the worker being installed *is* the first
 * one, and reloading would load the same build. Firefox reports that first
 * worker as `waiting` for a moment when the first page is reloaded while it
 * installs, which used to surface as "A new version is available" on an app the
 * user had just opened — pressing Reload then re-ran the identical build. This
 * is the guard that keeps the prompt for actual updates (#11 found it).
 *
 * An *update*, by contrast, always has a controller: the page is being served
 * by the old worker when the new one installs. So this guard cannot hide a real
 * update prompt. Measured on Firefox, the engine that exposed the bug: with the
 * page controlled by an active worker, a byte-changed `sw.js` still raises the
 * toast ("FF PROMPT SHOWN" in the #11 verification log), while the first-install
 * reload no longer does.
 *
 * With no ServiceWorker API at all (jsdom under Vitest, SSR) there is nothing
 * to compare and no container that could deliver a prompt, so `true` keeps the
 * historical behaviour instead of disabling the feature in every environment
 * that does not implement the API.
 */
function defaultIsControlled(): boolean {
	const container = globalThis.navigator?.serviceWorker;
	if (container === undefined) return true;
	return container.controller != null;
}

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
	register = registerSW,
	isControlled = defaultIsControlled
}: RegisterUpdatesOptions = {}): void {
	if (registered) return;
	registered = true;

	const updateServiceWorker = register({
		onNeedRefresh() {
			// A waiting worker on an uncontrolled page is the first install, not
			// an update: see `defaultIsControlled`.
			if (!isControlled()) return;
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
