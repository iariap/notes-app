import { describe, expect, it } from 'vitest';
import { PREVIEW_MAX_LENGTH, derivePreview } from '$lib/notes/preview';

describe('derivePreview', () => {
	it('skips the title line and shows what follows', () => {
		expect(derivePreview('# Groceries\n- [ ] buy milk\n- [x] eggs')).toBe('buy milk eggs');
	});

	it('returns an empty string when there is nothing after the title', () => {
		expect(derivePreview('Just a title')).toBe('');
		expect(derivePreview('Just a title\n\n   \n')).toBe('');
		expect(derivePreview('')).toBe('');
	});

	it('strips Markdown from the following lines', () => {
		expect(derivePreview('Title\n**bold** and _italic_')).toBe('bold and italic');
		expect(derivePreview('Title\n> quoted line')).toBe('quoted line');
		expect(derivePreview('Title\nsee [the docs](https://example.com)')).toBe('see the docs');
		expect(derivePreview('Title\n`pnpm test`')).toBe('pnpm test');
	});

	it('collapses whitespace across lines into single spaces', () => {
		expect(derivePreview('Title\n\n\nline   one\n\tline two')).toBe('line one line two');
	});

	it('starts after the *title* line, not after the first line', () => {
		// The title is the first line with text, so a blank first line must not
		// make the preview repeat the title.
		expect(derivePreview('\n\n# Real title\nbody text')).toBe('body text');
	});

	it('caps the preview at 100 characters with an ellipsis', () => {
		const body = `Title\n${'z'.repeat(300)}`;
		const result = derivePreview(body);

		expect(Array.from(result)).toHaveLength(PREVIEW_MAX_LENGTH);
		expect(result.endsWith('…')).toBe(true);
	});

	it('accepts a custom cap, for callers that need a narrower preview', () => {
		expect(derivePreview('Title\nabcdefghij', 5)).toBe('abcd…');
	});

	it('handles CRLF line endings', () => {
		expect(derivePreview('Title\r\nline one\r\nline two')).toBe('line one line two');
	});
});
