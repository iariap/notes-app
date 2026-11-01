import { expect, test } from '@playwright/test';
import { hydration, pressTab } from '../helpers/keyboard';
import { seedNote, seedNotes, waitForList, type SeedNote } from '../helpers/seed';
import {
	RICH_BODY,
	editorBody,
	editorStatus,
	placeCaretAtEnd,
	seriousAxeViolations,
	waitForMenuSettled,
	waitForToastSettled
} from './support';

/**
 * Cross-cutting accessibility (epic #1, non-functional): "fully
 * keyboard-operable, visible focus, labelled controls, WCAG AA contrast, zero
 * serious/critical axe violations" — required on **every route and state, in
 * every project**.
 *
 * ## What this adds over the feature specs
 *
 * #5–#9 each scan the routes and states their own feature introduced, so the
 * union is already wide. What no earlier spec did is enumerate the states as a
 * matrix and scan** all of them in every project**: the delete toast, the open
 * row menu, the save-error alert and the "deleted in another tab" message had
 * each been scanned once, in one project. A state that is clean in Chromium and
 * broken in WebKit is exactly the class of defect this issue exists to catch.
 *
 * ## The settled-animation rule
 *
 * Sonner toasts and bits-ui menus fade in by animating `opacity`. An
 * `opacity`-blended white-on-dark control reads as failing contrast *while it
 * animates* and passes once settled — a false positive, and the reason #8 and
 * #9 wait for the animation before scanning. This file waits the same way and
 * disables no rule.
 */

/** One note, rich enough to render something in the preview pane. */
function oneRichNote(): SeedNote[] {
	return [seedNote(1, RICH_BODY, new Date(Date.now() - 2 * 3_600_000).toISOString())];
}

/**
 * Forces the next IndexedDB write to fail, so the save-error alert appears —
 * the same seam `screenshots-editor.spec.ts` and story 3 use.
 */
async function failNextWrites(page: import('@playwright/test').Page): Promise<void> {
	await page.evaluate(() => {
		const original = IDBObjectStore.prototype.put;
		IDBObjectStore.prototype.put = function patched(): IDBRequest<IDBValidKey> {
			throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
		} as typeof IDBObjectStore.prototype.put;
		(window as unknown as { __restorePut: () => void }).__restorePut = () => {
			IDBObjectStore.prototype.put = original;
		};
	});
}

test.describe('accessibility — every route and state', () => {
	test('the list, empty state and populated state are axe-clean', async ({ page }, testInfo) => {
		await seedNotes(page, []);
		await waitForList(page);
		expect(
			await seriousAxeViolations(page, `empty list @ ${testInfo.project.name}`),
			'empty list'
		).toEqual([]);

		await seedNotes(page, oneRichNote());
		await waitForList(page);
		expect(
			await seriousAxeViolations(page, `populated list @ ${testInfo.project.name}`),
			'populated list'
		).toEqual([]);
	});

	test('the editor and the preview are axe-clean, in both layouts', async ({ page }, testInfo) => {
		const [note] = await seedNotes(page, oneRichNote());
		await waitForList(page);
		await page.goto(`/notes/${note.id}`);
		await hydration(page);
		await expect(editorBody(page)).toHaveValue(RICH_BODY);

		expect(
			await seriousAxeViolations(page, `editor/edit @ ${testInfo.project.name}`),
			'edit view'
		).toEqual([]);

		if ((page.viewportSize()?.width ?? 0) < 1280) {
			await page.getByRole('tab', { name: 'Preview' }).click();
		}
		await expect(page.getByTestId('preview-pane')).toBeVisible();
		expect(
			await seriousAxeViolations(page, `editor/preview @ ${testInfo.project.name}`),
			'preview view'
		).toEqual([]);
	});

	test('the new-note route and the missing-note route are axe-clean', async ({
		page
	}, testInfo) => {
		await page.goto('/notes/new');
		await hydration(page);
		expect(
			await seriousAxeViolations(page, `/notes/new @ ${testInfo.project.name}`),
			'/notes/new'
		).toEqual([]);

		await page.goto('/notes/does-not-exist');
		await hydration(page);
		await expect(page.getByTestId('editor-missing')).toBeVisible();
		expect(
			await seriousAxeViolations(page, `missing note @ ${testInfo.project.name}`),
			'missing note'
		).toEqual([]);
	});

	test('the delete toast and the open row menu are axe-clean', async ({ page }, testInfo) => {
		const [note] = await seedNotes(page, oneRichNote());
		await waitForList(page);
		await page.goto(`/notes/${note.id}`);
		await hydration(page);

		await page.getByRole('button', { name: 'Delete note' }).click();
		await expect(page.getByTestId('note-list-empty')).toBeVisible();
		await waitForToastSettled(page);
		expect(
			await seriousAxeViolations(page, `delete toast @ ${testInfo.project.name}`),
			'delete toast'
		).toEqual([]);

		// Undo, then open the row menu and scan with it settled.
		await page.getByRole('button', { name: 'Undo' }).click();
		await waitForList(page);
		// The Undo toast is still on screen and still fading out while the menu
		// opens. Scanning now measured the toast's exit animation — a
		// white-on-white `color-contrast` on `div[data-title]` — and reported it
		// as a violation of the row menu, which is what the tablet project caught
		// once workers were reduced (more contention made the fade slower). The
		// row-menu scan runs with the menu alone on screen, so the finding can only
		// be about the menu.
		await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
		await page.locator('[data-testid="note-row-menu"]').first().click();
		await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeVisible();
		await waitForMenuSettled(page);
		expect(
			await seriousAxeViolations(page, `row menu @ ${testInfo.project.name}`),
			'row menu'
		).toEqual([]);
	});

	test('the save-error alert is axe-clean', async ({ page }, testInfo) => {
		const [note] = await seedNotes(page, oneRichNote());
		await waitForList(page);
		await page.goto(`/notes/${note.id}`);
		await hydration(page);

		await failNextWrites(page);
		await placeCaretAtEnd(page);
		await page.keyboard.type(' that cannot be stored');
		await expect(page.getByTestId('editor-save-error')).toBeVisible();

		expect(
			await seriousAxeViolations(page, `save error @ ${testInfo.project.name}`),
			'save error'
		).toEqual([]);
	});

	test('the storage notice is axe-clean', async ({ page }, testInfo) => {
		await page.goto('/');
		await expect(page.getByTestId('storage-notice')).toBeVisible();

		expect(
			await seriousAxeViolations(page, `storage notice @ ${testInfo.project.name}`),
			'storage notice'
		).toEqual([]);
	});

	test('"This note was deleted in another tab" is axe-clean', async ({
		page,
		context
	}, testInfo) => {
		const [note] = await seedNotes(page, oneRichNote());
		await waitForList(page);

		const other = await context.newPage();
		await other.goto(`/notes/${note.id}`);
		await hydration(other);

		// Delete from the first tab; the second one reports it.
		await page.goto(`/notes/${note.id}`);
		await hydration(page);
		await page.getByRole('button', { name: 'Delete note' }).click();
		await expect(other.getByTestId('editor-deleted')).toBeVisible();

		expect(
			await seriousAxeViolations(other, `deleted in another tab @ ${testInfo.project.name}`),
			'deleted in another tab'
		).toEqual([]);
	});

	test('visible focus: every focused control shows a focus ring', async ({ page }, testInfo) => {
		// "Visible focus" is in the epic's non-functional list and axe cannot
		// check it. The assertion is on the computed outline/ring of the element
		// the browser reports as focused, so a control that swallows focus
		// invisibly (`outline: none` and no ring) fails here.
		await seedNotes(page, oneRichNote());
		await waitForList(page);
		await page.goto('/');
		await waitForList(page);

		const stops: string[] = [];
		for (let index = 0; index < 6; index += 1) {
			await pressTab(page);
			const focus = await page.evaluate(() => {
				const active = document.activeElement as HTMLElement | null;
				if (!active || active === document.body) return null;
				const style = getComputedStyle(active);
				return {
					label:
						active.getAttribute('aria-label') ??
						(active.textContent ?? '').trim().slice(0, 24) ??
						active.tagName,
					outlineWidth: style.outlineWidth,
					outlineStyle: style.outlineStyle,
					boxShadow: style.boxShadow
				};
			});
			if (focus === null) continue;
			stops.push(focus.label);
			// Either a real outline or a ring drawn with a shadow: both are
			// visible focus, and the app uses the latter (`focus-visible:ring-2`).
			const visible =
				(focus.outlineStyle !== 'none' && parseFloat(focus.outlineWidth) > 0) ||
				(focus.boxShadow !== 'none' && focus.boxShadow.trim().length > 0);
			expect(visible, `no visible focus on "${focus.label}" @ ${testInfo.project.name}`).toBe(true);
		}
		// The walk really visited something, so the assertion above is not vacuous.
		expect(stops.length).toBeGreaterThan(3);
	});

	test('every control has an accessible name', async ({ page }, testInfo) => {
		// "Labelled controls" from the epic. The name is resolved the way a
		// screen reader resolves it: `aria-labelledby`, then `aria-label`, then
		// the element's associated `<label>`s, then its text content, then
		// `title`. An icon-only button with none of those is the defect this
		// looks for.
		//
		// The label association matters here: the note body is named by a
		// visually hidden `<label for="note-body">`, which is exactly the pattern
		// this rule is supposed to accept. An earlier version of this walker
		// ignored `element.labels` and reported that textarea as unnamed — a bug
		// in the check, not in the app.
		await seedNotes(page, oneRichNote());
		await waitForList(page);
		await page.goto(`/notes/${oneRichNote()[0].id}`);
		await hydration(page);
		await expect(editorStatus(page)).toHaveText(/^(Saved|)$/);

		const nameless = await page.evaluate(() => {
			const text = (element: Element): string => (element.textContent ?? '').trim();

			/** The accessible name a screen reader would compute for `element`. */
			const accessibleName = (element: HTMLElement): string => {
				const labelledBy = element.getAttribute('aria-labelledby')?.trim();
				if (labelledBy) {
					const resolved = labelledBy
						.split(/\s+/)
						.map((id) => document.getElementById(id))
						.map((target) => (target ? text(target) : ''))
						.join(' ')
						.trim();
					if (resolved) return resolved;
				}
				const ariaLabel = element.getAttribute('aria-label')?.trim();
				if (ariaLabel) return ariaLabel;

				// `labels` is the real HTML association (`for` or wrapping), and it
				// is what a `<label for=...>` relies on.
				const labelable = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
				if ('labels' in labelable && labelable.labels !== null) {
					const fromLabels = [...labelable.labels]
						.map((label) => text(label))
						.join(' ')
						.trim();
					if (fromLabels) return fromLabels;
				}

				const content = text(element);
				if (content) return content;

				// An `<img>`/`<svg>` inside a control contributes its own name.
				const inner = element.querySelector('svg title, img[alt]');
				if (inner) {
					const innerName =
						inner.tagName.toLowerCase() === 'img' ? inner.getAttribute('alt')?.trim() : text(inner);
					if (innerName) return innerName;
				}

				return element.getAttribute('title')?.trim() ?? '';
			};

			const selector = 'button, a[href], input, select, textarea';
			return [...document.querySelectorAll<HTMLElement>(selector)]
				.filter((element) => {
					// `type="hidden"` is not focusable and not announced, so it is out
					// of scope for a naming rule.
					if (element.tagName === 'INPUT' && element.getAttribute('type') === 'hidden') {
						return false;
					}
					return accessibleName(element) === '';
				})
				.map((element) => element.outerHTML.slice(0, 120));
		});

		expect(nameless, `unnamed controls @ ${testInfo.project.name}`).toEqual([]);
	});
});
