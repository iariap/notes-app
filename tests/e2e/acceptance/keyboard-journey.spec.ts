import { expect, test, type Page } from '@playwright/test';
import { hydration, isSideBySide, keyboardNavigationKey, pressTab } from '../helpers/keyboard';
import { rows, waitForList } from '../helpers/seed';
import { deleteToast, editorBody, editorStatus, undoButton } from './support';

/**
 * The full journey without a mouse.
 *
 * Epic #1: "fully keyboard-operable". Each feature spec proves one *step* of
 * this from the keyboard — #5 the skip link and tab order, #6 the row links, #7
 * `Esc`, #8 the Undo focus hand-off, #9 the tabs. None of them proves the
 * *sequence*: a keyboard user must be able to do the whole thing — create,
 * write, read the preview, delete, undo, come back — and a single unreachable
 * control in the middle breaks the story even though every step passes alone.
 *
 * ## How "no mouse" is enforced
 *
 * The only inputs are `page.keyboard` and `locator.focus()`, plus `Enter` to
 * activate. There is no `click()` and no `mouse.*` call in this file. Tabbing
 * uses `pressTab`, which presses the key the current engine binds to it (WebKit
 * needs `Alt+Tab` for links; see `helpers/keyboard.ts`).
 *
 * ## Why every step asserts focus
 *
 * Moving focus without asserting it is how a "keyboard test" passes while the
 * user is lost. Each step names the control it expects to be focused before
 * pressing it, so a focus jump in the wrong direction fails at the step that
 * caused it rather than three assertions later.
 */

/** The focused element's identity, for assertions that name the stop. */
interface Focused {
	tag: string;
	testid: string | null;
	label: string;
}

function focused(page: Page): Promise<Focused> {
	return page.evaluate(() => {
		const active = document.activeElement as HTMLElement | null;
		if (active === null) return { tag: 'NONE', testid: null, label: '' };
		return {
			tag: active.tagName,
			testid: active.getAttribute('data-testid'),
			label: active.getAttribute('aria-label') ?? (active.textContent ?? '').trim().slice(0, 40)
		};
	});
}

/**
 * Tabs forward until the focused control's accessible name is `label`, or fails
 * with a message that says which control never came up.
 *
 * Bounded by `limit` rather than by "until it works": an unreachable control has
 * to fail, not hang until the test timeout, and the bound is the honest statement
 * of how many stops this journey is willing to pass through.
 */
async function tabTo(page: Page, label: string, limit = 12): Promise<void> {
	for (let index = 0; index < limit; index += 1) {
		if ((await focused(page)).label === label) return;
		await pressTab(page);
	}
	expect((await focused(page)).label, `"${label}" was never reached by tabbing`).toBe(label);
}

/**
 * The same walk, backwards.
 *
 * The editor's header (tabs, created date, status, Delete) precedes the panes in
 * document order, so from the textarea the way *back* to Delete is `Shift+Tab`.
 * Walking backwards to a named control rather than counting stops keeps the
 * journey honest when a header control is added: the assertion is about reaching
 * Delete, not about it being exactly one stop away.
 */
async function shiftTabTo(page: Page, label: string, limit = 12): Promise<void> {
	const key = keyboardNavigationKey(page).replace('Tab', 'Shift+Tab');
	for (let index = 0; index < limit; index += 1) {
		if ((await focused(page)).label === label) return;
		await page.keyboard.press(key);
	}
	expect((await focused(page)).label, `"${label}" was never reached by shift-tabbing`).toBe(label);
}

test.describe('keyboard-only journey', () => {
	test('create, write, preview, delete, undo, return — without a pointer', async ({ page }) => {
		await page.goto('/');
		await hydration(page);
		await waitForList(page);

		// --- 1. the skip link is the first stop, and it works -----------------
		await pressTab(page);
		await expect(page.getByTestId('skip-link')).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(page.locator('#main')).toBeFocused();

		// --- 2. reach "New note" from the main region and open the editor -----
		await tabTo(page, 'New note');
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(/\/notes\/new$/);
		await hydration(page);

		// --- 3. the editor owns focus, so typing needs no aiming --------------
		const body = editorBody(page);
		await expect(body).toBeFocused();
		await page.keyboard.type('# Keyboard note\n\n- [ ] milk');
		await expect(editorStatus(page)).toHaveText('Saved');
		await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}$/);

		// --- 4. read the rendered Markdown -----------------------------------
		if (!isSideBySide(page)) {
			// The tablist sits *before* the textarea in the editor's DOM order
			// (header first), so it is one `Shift+Tab` away; within the tablist the
			// tabs are a single stop with a roving tabindex and arrow keys move
			// between them — real tab semantics, so the journey uses them instead
			// of pretending each tab is its own tab stop.
			// Header order at every width below `xl` is: tablist → created date →
			// status → Delete, and the panes come after. So the tablist is behind
			// the textarea, and walking back to it (rather than counting stops)
			// keeps this honest if a header control is added.
			await body.focus();
			await shiftTabTo(page, 'Edit');
			await expect(page.getByRole('tab', { name: 'Edit' })).toBeFocused();
			await page.keyboard.press('ArrowRight');
			await expect(page.getByRole('tab', { name: 'Preview' })).toBeFocused();
			await page.keyboard.press('Enter');
			await expect(page.getByTestId('preview-pane')).toBeVisible();
			await expect(page.getByTestId('markdown-preview').locator('h1')).toHaveText('Keyboard note');

			// Back to Edit. Focus stays on the Preview tab, so the return trip is
			// the same control: arrow left, then activate. (The textarea cannot be
			// focused here — it is `display: none` while Preview is showing, which
			// is the correct behaviour for a tab interface.)
			await page.keyboard.press('ArrowLeft');
			await expect(page.getByRole('tab', { name: 'Edit' })).toBeFocused();
			await page.keyboard.press('Enter');
			await expect(body).toBeVisible();
		} else {
			// At `xl` both panes are up and there is no tab to press.
			await expect(page.getByTestId('markdown-preview').locator('h1')).toHaveText('Keyboard note');
		}

		// --- 5. delete it, from the keyboard --------------------------------
		// The editor header (tabs, created date, status, Delete) precedes the panes
		// in document order, so Delete is behind the textarea and reached with
		// `Shift+Tab`. Its accessible name is the same at every width.
		await body.focus();
		await shiftTabTo(page, 'Delete note');
		await expect(page.getByRole('button', { name: 'Delete note' })).toBeFocused();
		await page.keyboard.press('Enter');

		// --- 6. the toast is announced, and its Undo is reachable ------------
		await expect(deleteToast(page)).toBeVisible();
		await expect(page).toHaveURL('/');
		await undoButton(page).focus();
		await expect(undoButton(page)).toBeFocused();
		await page.keyboard.press('Enter');

		// --- 7. the note is back and focus is on something actionable --------
		await waitForList(page);
		await expect(rows(page)).toHaveCount(1);
		// Not `<body>`: the focus hand-off is what keeps a keyboard user in place
		// after a delete, and it has to survive the Undo round trip.
		await expect.poll(async () => (await focused(page)).tag).not.toBe('BODY');

		// --- 8. and the list is still navigable, which proves the journey
		//        ended somewhere usable rather than merely painted -----------
		await rows(page).first().focus();
		await expect(rows(page).first()).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}$/);
		await hydration(page);
		await expect(editorBody(page)).toHaveValue('# Keyboard note\n\n- [ ] milk');
	});

	test('every row contributes its two tab stops, in order', async ({ page }) => {
		// The structural counterpart to the journey above. The journey never
		// visits the list rows on the way out, so a control added to a row later
		// without a tab stop would slip past it; this walk proves each row's link
		// and its menu are both reachable, and in that order.
		// Two notes, created and left entirely from the keyboard. Leaving uses the
		// header title link: `Ctrl+Enter` only navigates below `md` (a known
		// limitation in docs/qa-v1.md), and this test must hold at every width.
		const leaveEditor = async () => {
			const title = page.getByRole('heading', { level: 1 }).getByRole('link', { name: 'Notes' });
			await title.focus();
			await expect(title).toBeFocused();
			await page.keyboard.press('Enter');
			await expect(page).toHaveURL('/');
			await waitForList(page);
		};

		await page.goto('/notes/new');
		await hydration(page);
		await page.keyboard.type('First note');
		await expect(editorStatus(page)).toHaveText('Saved');
		await leaveEditor();

		await page.getByRole('banner').getByRole('link', { name: 'New note' }).focus();
		await page.keyboard.press('Enter');
		// The shell is already mounted from the list route, so waiting for it says
		// nothing about this navigation: wait for the new editor to own focus.
		await expect(page).toHaveURL(/\/notes\/new$/);
		await expect(editorBody(page)).toBeFocused();
		await page.keyboard.type('Second note');
		await expect(editorStatus(page)).toHaveText('Saved');
		await leaveEditor();

		const rowCount = await rows(page).count();
		expect(rowCount).toBe(2);

		await rows(page).first().focus();
		await expect(rows(page).first()).toBeFocused();
		for (let index = 0; index < rowCount; index += 1) {
			await pressTab(page);
			await expect(
				page.locator('[data-testid="note-row-menu"]').nth(index),
				`row ${index}'s menu is not reachable from the keyboard`
			).toBeFocused();
			await pressTab(page);
			if (index < rowCount - 1) {
				await expect(
					rows(page).nth(index + 1),
					`row ${index + 1} is not reachable from the keyboard`
				).toBeFocused();
			}
		}
	});
});
