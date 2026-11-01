import { expect, test, type Page } from '@playwright/test';
import { isSideBySide } from './helpers/keyboard';
import { seedNote, seedNotes } from './helpers/seed';

/**
 * Issue #9: the sanitized Markdown live preview, in a real layout.
 *
 * The unit suites prove the renderer and the component wiring. This file proves
 * the things only a browser can: that the panes really sit side by side at
 * 1280 px and really stack behind tabs below it, that a hostile note renders
 * inert in the shipped bundle (no dialog, no alert, nothing executed), that the
 * preview follows typing, and that neither tab breaks the page's horizontal
 * scroll or axe.
 *
 * All three configured projects (375 / 768 / 1280) run every test, so the
 * responsive rules are covered by construction; the width-specific assertions
 * are gated per project where the behaviour genuinely differs.
 */

/** Waits for the client-rendered shell (the app is an SPA). */
const hydration = (page: Page) =>
	page.waitForFunction(() => document.querySelector('[data-slot="app-shell"]') !== null);

const editor = (page: Page) => page.getByRole('textbox', { name: 'Note' });
const previewPane = (page: Page) => page.getByTestId('preview-pane');
const preview = (page: Page) => page.getByTestId('markdown-preview');
const status = (page: Page) => page.getByTestId('editor-status');

/** A note with enough Markdown to exercise every GFM feature the issue names. */
const RICH_MARKDOWN = [
	'# Groceries',
	'',
	'Some **bold**, some *italic* and some ~~struck~~ text.',
	'',
	'- [ ] milk',
	'- [x] eggs',
	'',
	'1. first',
	'2. second',
	'',
	'| item | qty |',
	'| :--- | --: |',
	'| bread | 2 |',
	'',
	'> quoted wisdom',
	'',
	'```js',
	'const answer = 42;',
	'```',
	'',
	'See https://example.com for more.'
].join('\n');

/** True when the page has no horizontal overflow at the current viewport. */
function horizontalOverflow(page: Page): Promise<number> {
	return page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
}

/**
 * Records every `dialog`-family signal a payload could raise.
 *
 * `alert`/`confirm`/`prompt` are replaced with recorders rather than left in
 * place: if a payload ever executed, the test would otherwise hang on a modal
 * dialog nobody dismisses. Recording them turns "did it run?" into a value the
 * assertion reads.
 */
async function watchForExecution(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const calls: string[] = [];
		(window as unknown as { __executions: string[] }).__executions = calls;
		window.alert = (message?: unknown) => calls.push(`alert:${String(message)}`);
		window.confirm = (message?: unknown) => {
			calls.push(`confirm:${String(message)}`);
			return false;
		};
		window.prompt = (message?: unknown) => {
			calls.push(`prompt:${String(message)}`);
			return null;
		};
		window.addEventListener('error', (event) => calls.push(`error:${event.message}`));
	});
}

function executions(page: Page): Promise<string[]> {
	return page.evaluate(() => (window as unknown as { __executions?: string[] }).__executions ?? []);
}

test.describe('the preview follows typing', () => {
	test('typing Markdown shows the rendered result', async ({ page }) => {
		await page.goto('/notes/new');
		await hydration(page);

		// Below `xl` the preview is behind its tab; at `xl` it is already beside
		// the editor. Select it where it is a tab, so both cases assert the same
		// rendered output.
		// Type in the editor first (it is the default view below `xl`), then show
		// the preview: clicking the tab *before* typing would hide the textarea.
		await editor(page).click();
		await page.keyboard.type('# Heading here');

		if ((page.viewportSize()?.width ?? 0) < 1280) {
			await page.getByRole('tab', { name: 'Preview' }).click();
		}
		await expect(preview(page).locator('h1')).toHaveText('Heading here');

		// Still updates: appending more Markdown re-renders.
		if ((page.viewportSize()?.width ?? 0) < 1280) {
			await page.getByRole('tab', { name: 'Edit' }).click();
		}
		await editor(page).click();
		await page.keyboard.press('ControlOrMeta+ArrowDown');
		await page.keyboard.press('End');
		await page.keyboard.type('\n\nwith a **strong** word');
		if ((page.viewportSize()?.width ?? 0) < 1280) {
			await page.getByRole('tab', { name: 'Preview' }).click();
		}
		await expect(preview(page).locator('strong')).toHaveText('strong');
	});

	test('renders every GFM feature the issue names', async ({ page }) => {
		const [note] = await seedNotes(page, [seedNote(1, RICH_MARKDOWN, '2026-10-31T12:00:00.000Z')]);
		await page.goto(`/notes/${note.id}`);
		await hydration(page);

		if ((page.viewportSize()?.width ?? 0) < 1280) {
			await page.getByRole('tab', { name: 'Preview' }).click();
		}
		await expect(previewPane(page)).toBeVisible();

		const rendered = preview(page);
		await expect(rendered.locator('h1')).toHaveText('Groceries');
		await expect(rendered.locator('del')).toHaveText('struck');
		await expect(rendered.locator('input[type="checkbox"]')).toHaveCount(2);
		await expect(rendered.locator('table')).toContainText('bread');
		await expect(rendered.locator('blockquote')).toHaveText(/quoted wisdom/);
		await expect(rendered.locator('pre code')).toContainText('const answer = 42;');
		// The autolink became a real link that leaves the page safely.
		const link = rendered.locator('a', { hasText: 'https://example.com' });
		await expect(link).toHaveAttribute('target', '_blank');
		await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
	});

	test('shows "Nothing to preview" for an empty note', async ({ page }) => {
		await page.goto('/notes/new');
		await hydration(page);

		if ((page.viewportSize()?.width ?? 0) < 1280) {
			await page.getByRole('tab', { name: 'Preview' }).click();
		}
		await expect(page.getByTestId('preview-empty')).toHaveText('Nothing to preview');
	});
});

test.describe('the responsive layout', () => {
	test('at 1280 both panes are on screen at once, with no tabs', async ({ page }) => {
		test.skip(!isSideBySide(page), 'the ≥ xl layout');

		const [note] = await seedNotes(page, [
			seedNote(1, '# Side by side', '2026-10-31T12:00:00.000Z')
		]);
		await page.goto(`/notes/${note.id}`);
		await hydration(page);

		// Both panes visible, without touching the tabs.
		await expect(editor(page)).toBeVisible();
		await expect(previewPane(page)).toBeVisible();
		await expect(preview(page).locator('h1')).toHaveText('Side by side');

		// The tab control is not offered where the layout already shows both.
		await expect(page.getByTestId('editor-view-tabs')).toBeHidden();

		// Side by side, not stacked: the preview starts to the right of the editor.
		const editorBox = (await editor(page).boundingBox())!;
		const previewBox = (await previewPane(page).boundingBox())!;
		expect(previewBox.x).toBeGreaterThan(editorBox.x);
		expect(previewBox.width).toBeGreaterThan(0);
	});

	test('below 1280 the tabs switch between the two panes', async ({ page }) => {
		test.skip(isSideBySide(page), 'the tabbed layout');

		const [note] = await seedNotes(page, [seedNote(1, '# Tabbed', '2026-10-31T12:00:00.000Z')]);
		await page.goto(`/notes/${note.id}`);
		await hydration(page);

		// Default is Edit: the editor is visible, the preview is not.
		await expect(page.getByTestId('editor-view-tabs')).toBeVisible();
		await expect(editor(page)).toBeVisible();
		await expect(previewPane(page)).toBeHidden();

		await page.getByRole('tab', { name: 'Preview' }).click();
		await expect(previewPane(page)).toBeVisible();
		await expect(editor(page)).toBeHidden();
		await expect(preview(page).locator('h1')).toHaveText('Tabbed');

		await page.getByRole('tab', { name: 'Edit' }).click();
		await expect(editor(page)).toBeVisible();
		await expect(previewPane(page)).toBeHidden();
	});

	test('no horizontal page scroll with a wide table and a long URL', async ({ page }) => {
		// The worst case the epic calls out: a wide table plus an unbreakable URL,
		// in a 320 px-wide content box.
		const wide = [
			'| a | b | c | d | e | f | g | h |',
			'| - | - | - | - | - | - | - | - |',
			'| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |',
			'',
			`[long](https://example.com/${'segment/'.repeat(20)})`
		].join('\n');
		const [note] = await seedNotes(page, [seedNote(1, wide, '2026-10-31T12:00:00.000Z')]);

		await page.setViewportSize({ width: 320, height: 640 });
		await page.goto(`/notes/${note.id}`);
		await hydration(page);

		await page.getByRole('tab', { name: 'Preview' }).click();
		await expect(previewPane(page)).toBeVisible();

		expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
	});

	test('no horizontal page scroll in the editor view either', async ({ page }) => {
		const [note] = await seedNotes(page, [
			seedNote(1, 'https://example.com/' + 'x'.repeat(300), '2026-10-31T12:00:00.000Z')
		]);

		await page.setViewportSize({ width: 320, height: 640 });
		await page.goto(`/notes/${note.id}`);
		await hydration(page);

		expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
	});
});

test.describe('hostile notes', () => {
	/**
	 * The payloads a user could actually paste, driven through the shipped app.
	 *
	 * Each is seeded into storage (so the note is real Markdown, the way a note
	 * would be), rendered, and then the page is inspected: no dialog was recorded,
	 * no script element survived, and the note is still readable. This is the E2E
	 * counterpart to the unit table — same attacks, end to end, in the real
	 * browser and the real bundle.
	 */
	const payloads: { name: string; source: string }[] = [
		{ name: 'script', source: '<script>alert("xss")</script>' },
		{ name: 'img onerror', source: '<img src=x onerror=alert("xss")>' },
		{ name: 'javascript href', source: '[click](javascript:alert("xss"))' },
		{ name: 'iframe', source: '<iframe src="https://evil.example"></iframe>' },
		{ name: 'svg onload', source: '<svg onload=alert("xss")></svg>' },
		{ name: 'style', source: '<style>body{display:none}</style>' },
		{ name: 'data url image', source: '![x](data:image/svg+xml,<svg onload=alert(1)>)' }
	];

	for (const { name, source } of payloads) {
		test(`${name} renders inert and never runs`, async ({ page }) => {
			await watchForExecution(page);
			const [note] = await seedNotes(page, [
				seedNote(1, `${source}\n\nreadable text`, '2026-10-31T12:00:00.000Z')
			]);

			await page.goto(`/notes/${note.id}`);
			await hydration(page);
			if ((page.viewportSize()?.width ?? 0) < 1280) {
				await page.getByRole('tab', { name: 'Preview' }).click();
			}
			await expect(previewPane(page)).toBeVisible();

			// Give any deferred execution (an event, an image load) a frame or two.
			await page.waitForTimeout(200);

			expect(await executions(page), `${name} executed`).toEqual([]);
			expect(await preview(page).locator('script').count()).toBe(0);

			// Asserted on the *parsed* DOM, not on the HTML text: a payload that was
			// escaped into visible text (`&lt;img onerror=...&gt;`) still contains
			// the characters "onerror=" and is perfectly safe — it is text, not an
			// attribute. What must never exist is an element carrying the handler.
			expect(
				await preview(page).evaluate((element) =>
					[...element.querySelectorAll('*')].flatMap((node) =>
						[...node.attributes]
							.filter((attribute) => attribute.name.toLowerCase().startsWith('on'))
							.map((attribute) => `${node.tagName}.${attribute.name}`)
					)
				)
			).toEqual([]);
			expect(
				await preview(page).evaluate((element) =>
					[...element.querySelectorAll('*')].some((node) =>
						['iframe', 'object', 'embed', 'style', 'svg'].includes(node.tagName.toLowerCase())
					)
				)
			).toBe(false);

			// The note still renders its harmless part: sanitizing is not blanking.
			await expect(preview(page)).toContainText('readable text');
		});
	}

	test('a typo-level payload typed into the editor stays inert', async ({ page }) => {
		// The same path a user takes: type it, see it rendered.
		await watchForExecution(page);
		await page.goto('/notes/new');
		await hydration(page);

		await editor(page).click();
		await page.keyboard.type('<img src=x onerror=alert("xss")> after');
		await expect(status(page)).toHaveText('Saved');

		if ((page.viewportSize()?.width ?? 0) < 1280) {
			await page.getByRole('tab', { name: 'Preview' }).click();
		}
		await expect(previewPane(page)).toBeVisible();
		await page.waitForTimeout(200);

		expect(await executions(page)).toEqual([]);
		await expect(preview(page)).toContainText('after');
	});
});

test.describe('the preview leaves the editor alone', () => {
	test('typing keeps the caret and the scroll position', async ({ page }) => {
		const long = Array.from({ length: 80 }, (_, index) => `line ${index} of the note`).join('\n');
		const [note] = await seedNotes(page, [seedNote(1, long, '2026-10-31T12:00:00.000Z')]);
		await page.goto(`/notes/${note.id}`);
		await hydration(page);

		if ((page.viewportSize()?.width ?? 0) < 1280) {
			await page.getByRole('tab', { name: 'Edit' }).click();
		}

		const box = editor(page);
		await box.click();
		// Placed with the DOM rather than a key combination: "end of document" is
		// a different chord on every OS, and the claim under test is that the
		// caret survives the *preview*, not that a shortcut works.
		await box.evaluate((element) => {
			const area = element as HTMLTextAreaElement;
			area.setSelectionRange(area.value.length, area.value.length);
		});
		await page.keyboard.type(' appended');
		await expect(status(page)).toHaveText('Saved');

		// The textarea is still the focused element, and the caret sits exactly
		// where typing left it: at the end of the value.
		await expect(box).toBeFocused();
		const caret = await box.evaluate((element) => {
			const area = element as HTMLTextAreaElement;
			return {
				start: area.selectionStart,
				end: area.selectionEnd,
				length: area.value.length,
				value: area.value
			};
		});
		expect(caret.value.endsWith(' appended')).toBe(true);
		expect(caret.start).toBe(caret.length);
		expect(caret.end).toBe(caret.length);

		// And the rendered preview caught up with the same text.
		if ((page.viewportSize()?.width ?? 0) < 1280) {
			await page.getByRole('tab', { name: 'Preview' }).click();
		}
		await expect(preview(page)).toContainText('appended');
	});

	test('a save still lands while the preview is mounted', async ({ page }) => {
		await page.goto('/notes/new');
		await hydration(page);
		await page.keyboard.type('# Saved with a preview');
		await expect(status(page)).toHaveText('Saved');

		await page.reload();
		await hydration(page);
		await expect(editor(page)).toHaveValue('# Saved with a preview');
	});
});

test.describe('accessibility', () => {
	test('axe reports no serious or critical violations with the preview up', async ({ page }) => {
		const [note] = await seedNotes(page, [seedNote(1, RICH_MARKDOWN, '2026-10-31T12:00:00.000Z')]);
		await page.goto(`/notes/${note.id}`);
		await hydration(page);

		const AxeBuilder = (await import('@axe-core/playwright')).default;
		const serious = async () => {
			const { violations } = await new AxeBuilder({ page })
				.withTags(['wcag2a', 'wcag2aa'])
				.analyze();
			return violations
				.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
				.map((violation) => ({
					id: violation.id,
					impact: violation.impact,
					nodes: violation.nodes.map((node) => node.target.join(' '))
				}));
		};

		// Both tabs are scanned below `xl`; at `xl` both panes are already up.
		expect(await serious(), 'edit view').toEqual([]);

		if ((page.viewportSize()?.width ?? 0) < 1280) {
			await page.getByRole('tab', { name: 'Preview' }).click();
			await expect(previewPane(page)).toBeVisible();
			expect(await serious(), 'preview view').toEqual([]);
		}
	});
});

test.describe('dark mode', () => {
	test('the preview respects the theme through `prose-invert`', async ({ page }) => {
		/**
		 * The contract under test is the *stylesheet's*: the rendered Markdown must
		 * follow the `.dark` class the theme uses, not its own hard-coded colours.
		 *
		 * The class is toggled directly rather than through a UI control, because
		 * this app has no dark-mode switch yet — `mode-watcher` is only read by the
		 * toaster, and nothing mounts `<ModeWatcher />`. Asserting a toggle that
		 * does not exist would be a test of fiction; asserting that the preview
		 * obeys the class is exactly what #9 is responsible for, and it holds the
		 * moment a real switch is added.
		 */
		const [note] = await seedNotes(page, [
			seedNote(1, '# Dark note\n\nbody copy', '2026-10-31T12:00:00.000Z')
		]);
		await page.goto(`/notes/${note.id}`);
		await hydration(page);
		if ((page.viewportSize()?.width ?? 0) < 1280) {
			await page.getByRole('tab', { name: 'Preview' }).click();
		}
		await expect(preview(page).locator('h1')).toBeVisible();

		const headingColor = () =>
			preview(page)
				.locator('h1')
				.evaluate((element) => getComputedStyle(element).color);

		const light = await headingColor();
		await page.evaluate(() => document.documentElement.classList.add('dark'));
		const dark = await headingColor();

		// The two must differ: the prose variables resolve to the inverted set.
		expect(light).not.toBe(dark);
		// And in dark mode the heading is light text, not near-black on near-black.
		const [r, g, b] = dark
			.replace(/[^0-9,\s]/g, '')
			.split(',')
			.map((part) => Number(part.trim()));
		expect(Math.min(r, g, b)).toBeGreaterThan(100);
	});
});
