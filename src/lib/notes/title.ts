/**
 * Title derivation for the notes list.
 *
 * The body is the only input: the first non-empty line *is* the title (product
 * decision, epic #1). Markdown is stripped so the list never shows `# ` or
 * `- [ ]` noise, and the result is capped so a single long line cannot push the
 * dates out of a 320 px row.
 *
 * This file also owns `markdownLineToText`, the one-line Markdown flattener that
 * `preview.ts` reuses: title and preview must agree on what "plain text" means,
 * or a line could read differently in the two places that show it.
 */

/** Longest title the list renders, ellipsis included. */
export const TITLE_MAX_LENGTH = 80;

/** What the list shows when the body has no text at all. */
export const UNTITLED = 'Untitled';

const ESCAPED_CHARACTER = /\\([\\`*_{}[\]()#+\-.!>|~])/g;
// Escaped characters are parked on private-use sentinels while the strippers
// run, so `\*` survives as a literal `*` instead of being read as emphasis.
const ESCAPE_OPEN = '\uE000';
const ESCAPE_CLOSE = '\uE001';
const SENTINEL = /\uE000(\d+)\uE001/g;
const HORIZONTAL_RULE = /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const TABLE_DELIMITER = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;
const TABLE_ROW = /^\s*\|/;
const CODE_FENCE = /^\s{0,3}(?:`{3,}|~{3,})/;
const BLOCKQUOTE = /^\s{0,3}(?:>\s?)+/;
const HEADING = /^\s{0,3}#{1,6}\s+/;
const TASK_ITEM = /^\s*[-*+]\s+\[[ xX]\]\s+/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;
const INLINE_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const REFERENCE_LINK = /\[([^\]]*)\]\[[^\]]*\]/g;
const AUTOLINK = /<((?:https?|mailto):[^>\s]+)>/g;
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/g;
const CODE_SPAN = /`+([^`]*)`+/g;
// Emphasis markers only count when they wrap text and do not sit inside a word,
// so `snake_case_name` survives while `**bold**` and `_italic_` lose their marks.
const EMPHASIS = /(?<![A-Za-z0-9])(\*\*\*|\*\*|\*|___|__|_|~~)(?=\S)([\s\S]*?\S)\1(?![A-Za-z0-9])/g;
const WHITESPACE = /\s+/g;

/** Collapses every run of whitespace (including newlines) into one space. */
export function collapseWhitespace(text: string): string {
	return text.replace(WHITESPACE, ' ').trim();
}

/**
 * Cuts `text` to `max` characters, ellipsis included, without splitting a
 * surrogate pair (an emoji at the boundary stays whole or is dropped whole).
 */
export function truncate(text: string, max: number): string {
	const characters = Array.from(text);
	if (characters.length <= max) return text;
	return `${characters.slice(0, max - 1).join('')}…`;
}

/**
 * Plain text of a single Markdown line: block markers (heading, list, task,
 * quote, table) removed, inline syntax (emphasis, code, links, images, HTML,
 * autolinks) replaced by the text it wraps.
 *
 * Lines that carry no text at all — horizontal rules, code fences, table
 * delimiters — return `''`, which is what lets `deriveTitle` skip them.
 */
export function markdownLineToText(line: string): string {
	// A backslash escapes the next Markdown character; the character itself
	// stays. Escapes are parked on sentinels first, so `\*` is not then read as
	// the start of an emphasis run, and restored at the end.
	const escaped: string[] = [];
	let text = line.replace(ESCAPED_CHARACTER, (_, character: string) => {
		escaped.push(character);
		return `${ESCAPE_OPEN}${escaped.length - 1}${ESCAPE_CLOSE}`;
	});
	if (HORIZONTAL_RULE.test(text)) return '';
	if (CODE_FENCE.test(text)) return '';
	if (TABLE_DELIMITER.test(text)) return '';
	if (TABLE_ROW.test(text)) text = text.replace(/\|/g, ' ').trim();
	text = text.replace(BLOCKQUOTE, '');
	text = text.replace(HEADING, '');
	text = text.replace(TASK_ITEM, '');
	text = text.replace(LIST_ITEM, '');
	// Images before links: `![alt](src)` also matches the link pattern.
	text = text.replace(IMAGE, '$1');
	text = text.replace(AUTOLINK, '$1');
	text = text.replace(INLINE_LINK, '$1');
	text = text.replace(REFERENCE_LINK, '$1');
	text = text.replace(HTML_TAG, '');
	text = text.replace(CODE_SPAN, '$1');
	text = text.replace(EMPHASIS, '$2');
	return text.replace(SENTINEL, (_, index: string) => escaped[Number(index)]);
}

/**
 * Title of a note: the first line with text in it, Markdown stripped,
 * whitespace collapsed, capped at `TITLE_MAX_LENGTH`. `"Untitled"` when the
 * body has nothing to show.
 *
 * ```ts
 * deriveTitle('# Groceries')            // 'Groceries'
 * deriveTitle('- [ ] buy milk')         // 'buy milk'
 * deriveTitle('**bold**')               // 'bold'
 * deriveTitle('[docs](https://x.dev)')  // 'docs'
 * ```
 */
export function deriveTitle(body: string): string {
	for (const line of body.split(/\r?\n/)) {
		const text = collapseWhitespace(markdownLineToText(line));
		if (text.length > 0) return truncate(text, TITLE_MAX_LENGTH);
	}
	return UNTITLED;
}
