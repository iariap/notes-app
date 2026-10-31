import { describe, expect, it } from 'vitest';
import {
	TITLE_MAX_LENGTH,
	UNTITLED,
	collapseWhitespace,
	deriveTitle,
	markdownLineToText,
	truncate
} from '$lib/notes/title';

const title = (body: string) => deriveTitle(body);

describe('deriveTitle', () => {
	it('uses the first line as the title', () => {
		expect(title('Groceries')).toBe('Groceries');
		expect(title('Groceries\nmilk\neggs')).toBe('Groceries');
	});

	it('strips heading markers', () => {
		expect(title('# Groceries')).toBe('Groceries');
		expect(title('###### Deep heading')).toBe('Deep heading');
		// Not a heading: no space after the hashes.
		expect(title('#hashtag')).toBe('#hashtag');
	});

	it('strips list and task markers, keeping the task text', () => {
		expect(title('- [ ] buy milk')).toBe('buy milk');
		expect(title('- [x] buy milk')).toBe('buy milk');
		expect(title('- [X] buy milk')).toBe('buy milk');
		expect(title('* plain bullet')).toBe('plain bullet');
		expect(title('+ plus bullet')).toBe('plus bullet');
		expect(title('1. numbered')).toBe('numbered');
		expect(title('2) parenthesised')).toBe('parenthesised');
		expect(title('  - indented bullet')).toBe('indented bullet');
	});

	it('strips inline emphasis', () => {
		expect(title('**bold**')).toBe('bold');
		expect(title('_italic_')).toBe('italic');
		expect(title('***both***')).toBe('both');
		expect(title('~~struck~~')).toBe('struck');
		expect(title('a **b** c')).toBe('a b c');
	});

	it('keeps underscores inside a word (identifiers are not emphasis)', () => {
		expect(title('snake_case_name')).toBe('snake_case_name');
		expect(title('a_b_c')).toBe('a_b_c');
	});

	it('replaces links with their text', () => {
		expect(title('[docs](https://example.com)')).toBe('docs');
		expect(title('See [the docs](https://example.com) now')).toBe('See the docs now');
		expect(title('[reference][ref]')).toBe('reference');
		expect(title('<https://example.com>')).toBe('https://example.com');
	});

	it('replaces images with their alt text', () => {
		expect(title('![a cat](cat.png)')).toBe('a cat');
	});

	it('strips inline code markers but keeps the code', () => {
		expect(title('run `pnpm test`')).toBe('run pnpm test');
	});

	it('strips raw HTML tags but keeps the text', () => {
		expect(title('<b>hello</b> world')).toBe('hello world');
	});

	it('strips blockquote markers', () => {
		expect(title('> quoted')).toBe('quoted');
		expect(title('>> deeply quoted')).toBe('deeply quoted');
	});

	it('honours backslash escapes instead of stripping the escaped character', () => {
		expect(title('\\*not emphasis\\*')).toBe('*not emphasis*');
	});

	it('skips empty lines and lines with no text left', () => {
		expect(title('\n\n\n   \nAfter blank lines')).toBe('After blank lines');
		expect(title('---\nReal title')).toBe('Real title');
		expect(title('```ts\ncode')).toBe('code');
	});

	it('falls back to "Untitled" when nothing is left', () => {
		expect(title('')).toBe(UNTITLED);
		expect(title('   \n\t\n')).toBe(UNTITLED);
		expect(title('---')).toBe(UNTITLED);
		expect(title('```')).toBe(UNTITLED);
		expect(title('![only an image](x.png)')).toBe('only an image');
		expect(title('![](x.png)')).toBe(UNTITLED);
	});

	it('collapses internal whitespace', () => {
		expect(title('a    b\t\tc')).toBe('a b c');
	});

	it('truncates to 80 characters with an ellipsis', () => {
		const long = 'x'.repeat(200);
		const result = title(long);

		expect(Array.from(result)).toHaveLength(TITLE_MAX_LENGTH);
		expect(result.endsWith('…')).toBe(true);
		expect(result.slice(0, -1)).toBe('x'.repeat(TITLE_MAX_LENGTH - 1));
	});

	it('leaves a title of exactly 80 characters untouched', () => {
		const exact = 'y'.repeat(TITLE_MAX_LENGTH);
		expect(title(exact)).toBe(exact);
	});

	it('does not split a surrogate pair when truncating', () => {
		const result = title('😀'.repeat(100));
		expect(result.endsWith('…')).toBe(true);
		// 79 emoji plus the ellipsis, never a lone surrogate.
		expect(Array.from(result)).toHaveLength(TITLE_MAX_LENGTH);
		expect(result).toBe(`${'😀'.repeat(TITLE_MAX_LENGTH - 1)}…`);
	});

	it('handles CRLF line endings', () => {
		expect(title('# Windows\r\nbody')).toBe('Windows');
	});
});

describe('markdownLineToText', () => {
	it('returns an empty string for lines that carry no text', () => {
		expect(markdownLineToText('---')).toBe('');
		expect(markdownLineToText('***')).toBe('');
		expect(markdownLineToText('___')).toBe('');
		expect(markdownLineToText('```')).toBe('');
		expect(markdownLineToText('~~~')).toBe('');
		expect(markdownLineToText('| --- | --- |')).toBe('');
	});

	it('turns table rows into their cell text', () => {
		expect(markdownLineToText('| a | b |')).toBe('a   b');
	});

	it('keeps plain text as-is', () => {
		expect(markdownLineToText('just words')).toBe('just words');
	});
});

describe('collapseWhitespace', () => {
	it('collapses runs and trims', () => {
		expect(collapseWhitespace('  a\n\n b \t c  ')).toBe('a b c');
		expect(collapseWhitespace('')).toBe('');
	});
});

describe('truncate', () => {
	it('returns short text unchanged', () => {
		expect(truncate('abc', 3)).toBe('abc');
		expect(truncate('abc', 10)).toBe('abc');
	});

	it('cuts at the limit, ellipsis included', () => {
		expect(truncate('abcdef', 4)).toBe('abc…');
		expect(Array.from(truncate('abcdef', 4))).toHaveLength(4);
	});
});
