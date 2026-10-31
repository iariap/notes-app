/**
 * Preview derivation for the notes list: the readable text that follows the
 * title line, flattened to one line and capped so two lines of a 320 px row
 * stay readable.
 *
 * Markdown stripping is shared with `title.ts` (`markdownLineToText`) on
 * purpose: a line must not read as `**bold**` in the title and `bold` in the
 * preview, or the other way round.
 */
import { collapseWhitespace, markdownLineToText, truncate } from './title';

/** Longest preview the list renders, ellipsis included. */
export const PREVIEW_MAX_LENGTH = 100;

/**
 * Plain text of everything after the title line, whitespace collapsed and
 * capped at `PREVIEW_MAX_LENGTH`. `''` when the body has only a title (the list
 * then renders no preview row at all).
 *
 * ```ts
 * derivePreview('# Groceries\n- [ ] buy milk\n- [x] eggs')  // 'buy milk eggs'
 * derivePreview('Just a title')                             // ''
 * derivePreview('Title\n\n\n**two**')                       // 'two'
 * ```
 */
export function derivePreview(body: string, max: number = PREVIEW_MAX_LENGTH): string {
	const lines = body.split(/\r?\n/);
	const titleIndex = lines.findIndex((line) => markdownLineToText(line).trim().length > 0);
	if (titleIndex < 0) return '';
	const rest = collapseWhitespace(
		lines
			.slice(titleIndex + 1)
			.map(markdownLineToText)
			.join(' ')
	);
	if (rest.length === 0) return '';
	return truncate(rest, max);
}
