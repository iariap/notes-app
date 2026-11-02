import type { Locator, Page } from '@playwright/test';

/**
 * WCAG contrast, measured by the browser instead of by arithmetic.
 *
 * ## Why the browser measures it
 *
 * The theme is authored in `oklch()`, and `getComputedStyle` hands back
 * `oklab(0.55 0.21322 0.110169 / 0.9)` — parsing that in Node would mean
 * reimplementing both the colour conversion and the compositing, and the answer
 * would be this file's opinion rather than what a user sees. Painting the two
 * colours onto a 1×1 canvas makes the engine do both jobs, so the pixel read
 * back is the one a screenshot would show.
 *
 * ## Why composite, and not just pick two colours
 *
 * `text-destructive/90` is `color-mix(in oklab, var(--destructive) 90%,
 * transparent)`: a **translucent** foreground whose contrast depends on what is
 * behind it. Comparing the token against the background without first painting
 * it on top is exactly the blind spot #22 is about — at 90 % over white the old
 * token dropped below AA while the full-strength one did not.
 *
 * The technique started life inline in `delete.spec.ts` (#8/#11); it lives here
 * now so the token spec (#22) and that one measure the same way and cannot
 * drift apart.
 */

/** WCAG 2.x AA floor for normal-size text. */
export const AA_NORMAL_TEXT = 4.5;

export interface ContrastMeasurement {
	/** The foreground as the engine resolved it, e.g. `oklab(… / 0.9)`. */
	foreground: string;
	/**
	 * The background layers as the engine resolved them, outermost first.
	 *
	 * A list because a menu item is usually transparent and inherits its surface
	 * from an ancestor; painting the chain reproduces what actually shows behind
	 * the text.
	 */
	backgrounds: readonly string[];
	/** The foreground painted alone: its sRGB bytes and its alpha. */
	foregroundRgba: [number, number, number, number];
	/** The background layers composited: fully opaque, by construction. */
	backgroundRgb: [number, number, number];
	/** The pixel the engine draws for the foreground over those layers. */
	compositeRgb: [number, number, number];
	/** Foreground alpha, 0–1: proves a `/90` or a `color-mix` actually applied. */
	foregroundAlpha: number;
	/** WCAG 2.x ratio of `compositeRgb` against the background. */
	ratio: number;
}

/**
 * Measures `foreground` over `backgrounds`, all given as **CSS expressions**
 * (`var(--destructive)`, `oklch(…)`, `rgb(…)`, `color-mix(…)`), resolved
 * against the loaded stylesheet. `backgrounds` are painted in the order given,
 * so pass the outermost surface first.
 *
 * The stack must accumulate to an opaque colour: otherwise the number depends on
 * whatever else happens to sit behind it, and would be a guess about the page
 * rather than a property of the pair. The page-side half throws rather than
 * returning something that looks precise and is not.
 */
export function measureContrast(
	page: Page,
	foreground: string,
	...backgrounds: readonly string[]
): Promise<ContrastMeasurement> {
	return page.evaluate(measureContrastInPage, { foreground, backgrounds });
}

/**
 * Measures the contrast of an **existing element**, resolving the surface behind
 * it the way the compositor does: its own `background-color`, then each
 * ancestor's, until the stack is opaque.
 *
 * For an assertion about a control the user actually sees (`delete.spec.ts`'s
 * Undo button, a destructive menu item): the colours come from the rendered
 * element, so a utility class that stops applying shows up here, which measuring
 * the tokens alone would not catch.
 */
export async function measureContrastOn(
	page: Page,
	locator: Locator
): Promise<ContrastMeasurement> {
	const { foreground, backgrounds } = await locator.evaluate((element) => {
		const color = getComputedStyle(element).color;

		/** Whether a computed `background-color` paints any pixel at all. */
		const paints = (value: string): boolean =>
			value !== '' && value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)';

		// Every ancestor layer that contributes a pixel, outermost first.
		const layers: string[] = [];
		for (let node: Element | null = element; node !== null; node = node.parentElement) {
			const value = getComputedStyle(node).backgroundColor;
			if (paints(value)) layers.unshift(value);
		}

		return { foreground: color, backgrounds: layers };
	});

	return measureContrast(page, foreground, ...backgrounds);
}

/**
 * The page-side half of `measureContrast`.
 *
 * This body is **serialised into the page** by `page.evaluate`, so it must stay
 * self-contained: no imports, no references to module scope. Types are erased,
 * so they cost nothing at runtime.
 */
function measureContrastInPage(input: {
	foreground: string;
	backgrounds: readonly string[];
}): ContrastMeasurement {
	const probe = document.createElement('div');
	probe.setAttribute('aria-hidden', 'true');
	probe.style.cssText =
		'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
	document.body.append(probe);

	/** Lets the engine resolve a CSS expression, custom properties included. */
	const resolve = (property: 'color' | 'background-color', expression: string): string => {
		probe.style.setProperty(property, expression);
		const resolved = getComputedStyle(probe).getPropertyValue(property);
		probe.style.removeProperty(property);
		return resolved;
	};

	const foreground = resolve('color', input.foreground);
	const backgrounds = input.backgrounds.map((expression) =>
		resolve('background-color', expression)
	);
	probe.remove();

	const canvas = document.createElement('canvas');
	canvas.width = 1;
	canvas.height = 1;
	const context = canvas.getContext('2d');
	if (context === null) throw new Error('2d canvas unavailable');

	/**
	 * Paints `colors` in order onto one pixel and reads the result back.
	 *
	 * Painting a colour that carries alpha blends it with what is already on the
	 * canvas — the same operation the compositor performs — and `getImageData`
	 * returns the un-premultiplied bytes, so a colour painted alone reports its
	 * own alpha.
	 */
	const paint = (colors: readonly string[]): [number, number, number, number] => {
		context.clearRect(0, 0, 1, 1);
		for (const color of colors) {
			context.fillStyle = color;
			context.fillRect(0, 0, 1, 1);
		}
		const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
		return [r, g, b, a];
	};

	const foregroundRgba = paint([foreground]);
	const [backgroundR, backgroundG, backgroundB, backgroundA] = paint(backgrounds);
	const [r, g, b] = paint([...backgrounds, foreground]);

	if (backgroundA !== 255) {
		throw new Error(
			`the background must accumulate to an opaque colour: ${input.backgrounds.join(' + ') || '(none)'} resolved to ${backgrounds.join(' + ') || '(none)'} (alpha ${backgroundA})`
		);
	}

	/** Relative luminance, per WCAG 2.x. */
	const luminance = (rgb: readonly [number, number, number]): number => {
		const channel = (value: number): number => {
			const scaled = value / 255;
			return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
		};
		return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
	};

	const backgroundRgb: [number, number, number] = [backgroundR, backgroundG, backgroundB];
	const compositeRgb: [number, number, number] = [r, g, b];
	const lighter = Math.max(luminance(compositeRgb), luminance(backgroundRgb));
	const darker = Math.min(luminance(compositeRgb), luminance(backgroundRgb));

	return {
		foreground,
		backgrounds,
		foregroundRgba,
		backgroundRgb,
		compositeRgb,
		foregroundAlpha: foregroundRgba[3] / 255,
		ratio: (lighter + 0.05) / (darker + 0.05)
	};
}
