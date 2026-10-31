/**
 * `$effect` is only usable inside `.svelte`/`.svelte.ts` files, so tests that
 * assert reactivity go through this helper instead of reaching for the rune
 * in a `.spec.ts`.
 */
import { flushSync } from 'svelte';

export interface EffectProbe {
	readonly runs: number;
	dispose(): void;
}

/** Records `read()` on every reactive change, starting immediately. */
export function probeEffects<T>(read: () => T, seen: T[]): EffectProbe {
	const cleanup = $effect.root(() => {
		$effect(() => {
			seen.push(read());
		});
	});
	flushSync();
	return {
		get runs() {
			return seen.length;
		},
		dispose() {
			cleanup();
			flushSync();
		}
	};
}

/** Flushes pending effects without waiting for real time to pass. */
export function settle(): void {
	flushSync();
}
