import { beforeEach, describe, expect, it, vi } from 'vitest';

const registerSW = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());

vi.mock('virtual:pwa-register', () => ({ registerSW }));
vi.mock('svelte-sonner', () => ({ toast }));

import {
	registerServiceWorkerUpdates,
	resetServiceWorkerUpdatesForTests,
	UPDATE_TOAST_ACTION,
	UPDATE_TOAST_ID,
	UPDATE_TOAST_MESSAGE
} from '$lib/pwa/updates';

type RegisterOptions = Parameters<typeof registerSW>[0];

/** Captures the options the module hands to `registerSW`. */
function captureRegisterOptions() {
	registerSW.mockImplementation(() => vi.fn(async () => {}));
	registerServiceWorkerUpdates();
	return registerSW.mock.calls[0][0] as RegisterOptions;
}

describe('service worker update prompt', () => {
	beforeEach(() => {
		registerSW.mockReset();
		toast.mockReset();
		resetServiceWorkerUpdatesForTests();
	});

	it('registers the service worker once, in prompt mode', () => {
		registerSW.mockImplementation(() => vi.fn(async () => {}));

		registerServiceWorkerUpdates();
		registerServiceWorkerUpdates();

		expect(registerSW).toHaveBeenCalledOnce();
		// `immediate` would register before the page is interactive; the plugin's
		// default already defers to `load`.
		expect((registerSW.mock.calls[0][0] as RegisterOptions).immediate).toBeUndefined();
	});

	it('shows "A new version is available" with a Reload action when a worker waits', () => {
		const options = captureRegisterOptions();

		options.onNeedRefresh?.();

		expect(toast).toHaveBeenCalledOnce();
		const [message, data] = toast.mock.calls[0];
		expect(message).toBe(UPDATE_TOAST_MESSAGE);
		expect(UPDATE_TOAST_MESSAGE).toBe('A new version is available');
		expect(data.id).toBe(UPDATE_TOAST_ID);
		// A version notice must survive until the user acts: auto-dismissing it
		// would hide the only control that applies the update.
		expect(data.duration).toBe(Infinity);
		expect(data.action.label).toBe('Reload');
		expect(UPDATE_TOAST_ACTION).toBe('Reload');
	});

	it('reloads only when the Reload action is pressed', async () => {
		const updateServiceWorker = vi.fn(async () => {});
		registerSW.mockImplementation(() => updateServiceWorker);
		registerServiceWorkerUpdates();
		const options = registerSW.mock.calls[0][0] as RegisterOptions;

		options.onNeedRefresh?.();

		const [, data] = toast.mock.calls[0];
		// Nothing happened while the toast was merely shown.
		expect(updateServiceWorker).not.toHaveBeenCalled();

		data.action.onClick(new MouseEvent('click'));

		await vi.waitFor(() => expect(updateServiceWorker).toHaveBeenCalledOnce());
		expect(updateServiceWorker).toHaveBeenCalledWith(true);
	});

	it('calls the same update function even when the prompt fires twice', () => {
		const updateServiceWorker = vi.fn(async () => {});
		registerSW.mockImplementation(() => updateServiceWorker);
		registerServiceWorkerUpdates();
		const options = registerSW.mock.calls[0][0] as RegisterOptions;

		options.onNeedRefresh?.();
		options.onNeedRefresh?.();

		expect(toast).toHaveBeenCalledTimes(2);
		// Same id both times: svelte-sonner replaces the toast instead of stacking.
		expect(toast.mock.calls[0][1].id).toBe(toast.mock.calls[1][1].id);

		toast.mock.calls[1][1].action.onClick(new MouseEvent('click'));
		expect(updateServiceWorker).toHaveBeenCalledOnce();
	});

	/**
	 * The false positive the WebKit and Firefox projects found (#11).
	 *
	 * "A new version is available" compares a waiting worker against the version
	 * the page is *running*. On a first visit there is no such version: the
	 * worker being installed is the first one, and the page is not controlled
	 * by anything yet. Firefox reports that first worker as `waiting` for a
	 * moment when the first page is reloaded while it installs, and the prompt
	 * fired for a version that does not replace anything — the user pressed
	 * "Reload" and got the same build twice.
	 */
	it('does not prompt when the page is not controlled by a worker yet', () => {
		registerSW.mockImplementation(() => vi.fn(async () => {}));
		registerServiceWorkerUpdates({ isControlled: () => false });
		const options = registerSW.mock.calls[0][0] as RegisterOptions;

		options.onNeedRefresh?.();

		expect(toast).not.toHaveBeenCalled();
	});

	it('prompts when a controlled page is running an older worker', () => {
		registerSW.mockImplementation(() => vi.fn(async () => {}));
		registerServiceWorkerUpdates({ isControlled: () => true });
		const options = registerSW.mock.calls[0][0] as RegisterOptions;

		options.onNeedRefresh?.();

		expect(toast).toHaveBeenCalledOnce();
		expect(toast.mock.calls[0][0]).toBe(UPDATE_TOAST_MESSAGE);
	});

	/**
	 * The guard must not swallow a genuine update.
	 *
	 * An update happens on a page that a worker is already serving, so the real
	 * `navigator.serviceWorker.controller` is non-null and the prompt fires. This
	 * pins that relationship: the default reading of `controller` is what decides,
	 * not a constant.
	 */
	it('prompts on a controlled page by reading the real controller', () => {
		const original = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
		const controller = { scriptURL: '/sw.js', state: 'activated' };
		Object.defineProperty(navigator, 'serviceWorker', {
			configurable: true,
			value: { controller }
		});
		try {
			registerSW.mockImplementation(() => vi.fn(async () => {}));
			registerServiceWorkerUpdates();
			const options = registerSW.mock.calls[0][0] as RegisterOptions;

			options.onNeedRefresh?.();
			expect(toast).toHaveBeenCalledOnce();
		} finally {
			if (original) Object.defineProperty(navigator, 'serviceWorker', original);
			else Reflect.deleteProperty(navigator, 'serviceWorker');
		}
	});

	it('stays silent on an uncontrolled page by reading the real controller', () => {
		const original = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
		Object.defineProperty(navigator, 'serviceWorker', {
			configurable: true,
			value: { controller: null }
		});
		try {
			registerSW.mockImplementation(() => vi.fn(async () => {}));
			registerServiceWorkerUpdates();
			const options = registerSW.mock.calls[0][0] as RegisterOptions;

			options.onNeedRefresh?.();
			// This is the first-install case the Firefox/WebKit projects found.
			expect(toast).not.toHaveBeenCalled();
		} finally {
			if (original) Object.defineProperty(navigator, 'serviceWorker', original);
			else Reflect.deleteProperty(navigator, 'serviceWorker');
		}
	});

	it('logs a registration failure without bothering the user', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const options = captureRegisterOptions();

		options.onRegisterError?.(new Error('nope'));

		expect(error).toHaveBeenCalledOnce();
		expect(toast).not.toHaveBeenCalled();
		error.mockRestore();
	});
});
