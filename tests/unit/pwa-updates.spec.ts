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

	it('logs a registration failure without bothering the user', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const options = captureRegisterOptions();

		options.onRegisterError?.(new Error('nope'));

		expect(error).toHaveBeenCalledOnce();
		expect(toast).not.toHaveBeenCalled();
		error.mockRestore();
	});
});
