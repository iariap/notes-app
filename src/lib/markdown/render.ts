/**
 * Markdown → HTML, sanitized. The **only** place in this app that produces HTML,
 * and therefore its only XSS surface.
 *
 * The stored note is always Markdown source; nothing rendered here is ever
 * persisted. A note is untrusted input (it may be pasted from a page, synced in
 * from another tab, or written by someone else), so the pipeline assumes the
 * worst about every character:
 *
 *   Markdown source ──marked (GFM)──▶ HTML ──DOMPurify (allowlist)──▶ HTML
 *
 * ## What happens to raw HTML in a note
 *
 * `marked` passes raw HTML through untouched, so a note containing
 * `<img src=x onerror=alert(1)>` would become live markup. Raw HTML is **kept
 * but sanitized**: harmless tags from a small allowlist survive, everything else
 * is removed (or unwrapped, for elements whose text is worth keeping). Keeping
 * the safe subset is what makes pasted tables, `<br>` and `<sub>` behave the way
 * people expect; the allowlist is what keeps it inert. Raw HTML can therefore
 * never execute — sanitizing rather than stripping is the choice, and the
 * allowlist is the guarantee.
 *
 * ## Why an allowlist instead of DOMPurify's defaults
 *
 * The defaults are already good, and they are still not what this app wants:
 * they carry ~200 tags (including `style`, `dialog`, `marquee`, `form`,
 * `template`) and ~150 attributes, and they treat `data:` as a legitimate image
 * source. Each of those is a promise someone else made about their
 * requirements. The configuration below states this app's requirements instead,
 * and `tests/unit/markdown-render.spec.ts` holds it to them.
 */
import DOMPurify, { type Config } from 'dompurify';
import { Marked, Renderer } from 'marked';

/**
 * GFM (tables, task lists, strikethrough, autolinks) plus `breaks`, so a single
 * newline is a line break — the behaviour people expect from a notes app rather
 * than from a Markdown spec.
 */
const markdown = new Marked({ gfm: true, breaks: true });

/** The class that makes a table scroll inside its own box; see `render.ts`. */
export const TABLE_WRAPPER_CLASS = 'markdown-table-wrap';

/**
 * Wraps every table in a scrolling box.
 *
 * A GFM table is as wide as its content, and a note can put a 12-column table
 * in a 375 px pane. `prose` sets `width: 100%` on the table itself but nothing
 * keeps its *cells* from pushing it wider, so an unwrapped table is the one way
 * Markdown can give the whole page a horizontal scrollbar — which the epic
 * forbids at 320 px. The wrapper is the scroll container, so the overflow stays
 * inside the preview.
 *
 * **Own property, deliberately.** `marked.use({ renderer })` copies the object
 * with `for...in`, which skips prototype methods: a `Renderer` subclass or a
 * class method would be silently ignored and tables would render unwrapped
 * (verified — the first attempt did exactly that). An enumerable own property
 * on an object literal is registered.
 */
markdown.use({
	renderer: {
		table(token) {
			// `this` is marked's renderer, so a throwaway one can render the real
			// table with the same parser without recursing back into this override.
			const base = new Renderer(this.options);
			base.parser = this.parser;
			return `<div class="${TABLE_WRAPPER_CLASS}">${base.table(token)}</div>`;
		}
	}
});

/**
 * Elements the renderer may emit, plus a conservative slice of raw HTML.
 *
 * The first group is what `marked` produces for GFM; the second is what makes
 * pasted HTML useful without being dangerous. Notably absent, on purpose:
 *
 * - `script`, `style`, `iframe`, `object`, `embed`, `link`, `meta`, `base`:
 *   code execution, request side-channels and document-level rewrites;
 * - `svg`, `math`: separate namespaces with their own XSS history (`onload`,
 *   `xlink:href`, `foreignObject`) and nothing this app needs;
 * - `form`, `button`, `select`, `textarea`: a preview that can collect input
 *   invites a phishing page drawn with someone else's note;
 * - `template`, `noscript`, `noembed`, `plaintext`: mXSS parser-differential
 *   gadgets, which DOMPurify also lists as forbidden content.
 */
const ALLOWED_TAGS = [
	// Produced by `marked` for GFM.
	'a',
	'blockquote',
	'br',
	'code',
	'del',
	'em',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'hr',
	'img',
	'input',
	'li',
	'ol',
	'p',
	'pre',
	'strong',
	'table',
	'tbody',
	'td',
	'th',
	'thead',
	'tr',
	'ul',
	// Safe raw HTML a pasted note may carry.
	'abbr',
	'b',
	'caption',
	'cite',
	'dd',
	'details',
	'dfn',
	'div',
	'dl',
	'dt',
	'figcaption',
	'figure',
	'i',
	'ins',
	'kbd',
	'mark',
	'q',
	's',
	'samp',
	'section',
	'small',
	'span',
	'sub',
	'summary',
	'sup',
	'tfoot',
	'time',
	'u',
	'var'
] as const;

/**
 * Attributes the renderer may emit, plus what raw HTML needs to stay useful.
 *
 * Every `on*` handler is absent, which is what makes them impossible rather
 * than merely filtered. Also absent: `style` (CSS exfiltration and UI redress),
 * `srcdoc`, `formaction`/`action`/`ping` (navigation), `srcset` (a second,
 * easily-forgotten URL channel), and `id`/`name` (DOM clobbering).
 *
 * `class` is here only because `marked` tags code fences with
 * `class="language-js"`; a hook below drops it from every other element.
 */
const ALLOWED_ATTR = [
	'align',
	'alt',
	'checked',
	'class',
	'colspan',
	'datetime',
	'dir',
	'disabled',
	'href',
	'lang',
	'open',
	'reversed',
	'rowspan',
	'scope',
	'src',
	'start',
	'title',
	'type'
] as const;

/**
 * The only schemes a URL may carry, over DOMPurify's default.
 *
 * `http:`, `https:` and `mailto:` are allowed because a note links to the web.
 * Everything else is refused: `javascript:`, `data:`, `vbscript:`, `file:`, and
 * also `ftp:`/`tel:`/`sms:` which DOMPurify permits by default. The last
 * alternative matches a URL with **no** scheme at all — a relative path or a
 * `#fragment` — which cannot execute; a leading `[a-z]` that reaches a colon
 * can never satisfy it, which is what makes `javascript:` fail.
 */
const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i;

/** Attributes the sanitizer must never keep, whatever a future allowlist says. */
const FORBIDDEN_ATTR = [
	'action',
	'background',
	'formaction',
	'ping',
	'poster',
	'srcset',
	'srcdoc',
	'style',
	'xlink:href'
] as const;

/** Elements removed with their whole subtree. */
const FORBIDDEN_TAGS = [
	'applet',
	'base',
	'embed',
	'form',
	'frame',
	'frameset',
	'iframe',
	'link',
	'meta',
	'noscript',
	'object',
	'script',
	'style',
	'template'
] as const;

/**
 * The sanitizer configuration, exported so the security tests can assert on the
 * options themselves and not only on their observable effect.
 *
 * Read top to bottom as the list of decisions:
 *
 * - `ALLOWED_TAGS` / `ALLOWED_ATTR` — an allowlist, so anything not named is
 *   dropped even if a future DOMPurify release decides it is safe.
 * - `FORBID_TAGS` / `FORBID_ATTR` — the same intent stated twice; forbidding
 *   wins over allowing, so re-adding a name above cannot quietly re-enable it.
 * - `ALLOWED_URI_REGEXP` — schemes, per the comment above.
 * - `ALLOW_DATA_ATTR: false` — `data-*` is a channel into app CSS/JS and a
 *   clobbering trick; nothing this renderer produces needs it.
 * - `ALLOW_ARIA_ATTR: false` — same reasoning: the preview's semantics come
 *   from its elements, never from attributes carried by a note.
 * - `ALLOW_UNKNOWN_PROTOCOLS: false` — the documented default, stated so the
 *   fail-closed direction is explicit rather than inherited.
 * - `ALLOW_SELF_CLOSE_IN_ATTR: false` — closes an mXSS gadget.
 * - `SANITIZE_DOM: true` — DOMPurify's clobbering guard, kept on explicitly.
 * - `ALLOWED_NAMESPACES` — XHTML only; SVG/MathML never parse.
 *
 * `FORBID_CONTENTS` is deliberately left at DOMPurify's default (script, style,
 * iframe, svg, math, template, …), which is a superset of what is forbidden
 * here and exists precisely so a removed element takes its subtree with it.
 */
export const MARKDOWN_SANITIZE_CONFIG: Config = {
	ALLOWED_TAGS: [...ALLOWED_TAGS],
	ALLOWED_ATTR: [...ALLOWED_ATTR],
	ALLOWED_URI_REGEXP,
	FORBID_TAGS: [...FORBIDDEN_TAGS],
	FORBID_ATTR: [...FORBIDDEN_ATTR],
	ALLOW_DATA_ATTR: false,
	ALLOW_ARIA_ATTR: false,
	ALLOW_UNKNOWN_PROTOCOLS: false,
	ALLOW_SELF_CLOSE_IN_ATTR: false,
	SANITIZE_DOM: true,
	ALLOWED_NAMESPACES: ['http://www.w3.org/1999/xhtml']
};

/** The two elements whose `class` is a `marked` language hint, not styling. */
const CLASS_ATTRIBUTE_TAGS = new Set(['code', 'pre']);

/**
 * The only shape of `class` kept on `code`/`pre`: the language hint `marked`
 * emits for a fenced block (`language-js`, `language-c++`, `language-c#`).
 *
 * Restricting the *value*, not just the element, is what stops a note's own
 * `<code class="…">` from borrowing a utility class — the same reason a note's
 * `<div class="…">` is rejected below. A class on `code`/`pre` is a hint for a
 * future highlighter; anything that is not a hint has no reason to survive.
 */
const LANGUAGE_HINT_CLASS = /^language-[a-z0-9#+-]+$/i;

/**
 * `class` is allowed on `code`/`pre` **only** as a `marked` language hint, and
 * on `div` **only** for the table wrapper this renderer emits.
 *
 * A note's own `<div class="...">` (or `<code class="...">`) loses it: the
 * preview's styling is the app's, and letting a note choose classes would let
 * it borrow any utility the app ships.
 */
function keepClass(node: Element, value: string): boolean {
	const name = node.nodeName.toLowerCase();
	if (CLASS_ATTRIBUTE_TAGS.has(name)) return LANGUAGE_HINT_CLASS.test(value);
	return name === 'div' && value === TABLE_WRAPPER_CLASS;
}

/**
 * `data:` is refused even where DOMPurify would accept it.
 *
 * DOMPurify allows `data:` for `img`/`source`/`video` on purpose: a data-URI
 * image is not script execution inside an `<img>`. The requirement here is
 * stricter — no `data:` URLs at all — and `ALLOWED_URI_REGEXP` cannot express
 * it, because DOMPurify checks that per-tag allowance independently of, and
 * after, the scheme regexp.
 */
export const DATA_URL = /^\s*data:/i;

/**
 * Every attribute `DATA_URL` is enforced against.
 *
 * `src` was the original case (an `<img src="data:…">`); `href` is the same
 * hole on a link, and is the one that actually navigates. Both are checked on
 * every element, not per-tag: DOMPurify's own allowance for `data:` is keyed by
 * element, and this check exists precisely to not depend on that.
 */
export const DATA_URL_ATTRIBUTES = ['src', 'href'] as const;

let hooksInstalled = false;

/**
 * Installs the hooks once per DOMPurify instance.
 *
 * All three are static decisions (remove this, rewrite that), so installing them
 * twice could not change the output; doing it once just keeps that a non-issue.
 */
function installHooks(): void {
	if (hooksInstalled) return;
	hooksInstalled = true;

	// The only `<input>` a preview has a use for is a task-list checkbox. Any
	// other kind is a form control — either a phishing affordance or a way to
	// make the read-only preview take input.
	DOMPurify.addHook('uponSanitizeElement', (node, event) => {
		if (event.tagName !== 'input') return;
		const element = node as Element;
		if ((element.getAttribute('type') ?? '').toLowerCase() === 'checkbox') return;
		element.remove();
	});

	// `class` survives only where it carries meaning: a code fence's language
	// hint, or the table wrapper this renderer itself emits.
	DOMPurify.addHook('uponSanitizeAttribute', (node, event) => {
		if (event.attrName.toLowerCase() !== 'class') return;
		if (keepClass(node as Element, event.attrValue)) return;
		event.keepAttr = false;
	});

	// Post-sanitization work: the guarantees an allowlist cannot state, because
	// they are about *values* and about *adding* what Markdown cannot express.
	DOMPurify.addHook('afterSanitizeAttributes', (node) => {
		if (node.nodeName === 'A' && node.hasAttribute('href')) {
			// Every link opens in a new tab — `[x](url)`, an autolink, or a raw
			// `<a>` in the note alike. `noopener` denies the opened page a handle
			// on this one; `noreferrer` keeps the note's URL out of its
			// `Referer`. Both are set, never appended to: a note cannot supply
			// its own `rel`, so it cannot weaken either.
			node.setAttribute('target', '_blank');
			node.setAttribute('rel', 'noopener noreferrer');
		}
		if (node.nodeName === 'INPUT') {
			// The preview is read-only: a task-list checkbox is a picture of a
			// checkbox, not a control the reader can tick.
			node.setAttribute('disabled', '');
			// And it still needs an accessible name. `marked` emits a bare
			// `<input type="checkbox">` with no label, which is a critical axe
			// violation (`label`) — a screen reader would announce an unnamed
			// checkbox. The name is derived from the token's own state, so it says
			// what the checkbox means rather than naming a control that has none.
			node.setAttribute(
				'aria-label',
				node.hasAttribute('checked') ? 'Completed task' : 'Incomplete task'
			);
		}
		// A `data:` URL cannot survive on any navigable or fetchable attribute,
		// because the next request will be an `href`. Dropping it here covers both
		// the element that carries it today and the one added tomorrow, so a
		// future DOMPurify release loosening its per-tag allowance cannot reopen
		// the hole.
		for (const attribute of DATA_URL_ATTRIBUTES) {
			const value = node.getAttribute(attribute);
			if (value !== null && DATA_URL.test(value)) node.removeAttribute(attribute);
		}
	});
}

/**
 * Renders Markdown to HTML that is safe to hand to `{@html}`.
 *
 * Fails **closed** at every step, because the alternative to "no preview" is
 * "raw attacker HTML", and that trade is not close:
 *
 * - a non-string returns `''` (a note body that has not loaded yet);
 * - `!DOMPurify.isSupported` returns `''`, since DOMPurify hands its input back
 *   verbatim in that state and forwarding it would publish the HTML it refused
 *   to vet;
 * - a throwing `marked.parse` returns `''`;
 * - a throwing `DOMPurify.sanitize` returns `''` too. Sanitizing is the last
 *   step of the pipeline, and a throw here would otherwise escape into the
 *   caller and take the editor down — the one place where degrading to an empty
 *   preview is strictly better than the alternative.
 */
export function renderMarkdown(source: string): string {
	if (typeof source !== 'string' || source.length === 0) return '';
	if (!DOMPurify.isSupported) return '';

	installHooks();

	let html: string;
	try {
		html = markdown.parse(source, { async: false });
	} catch {
		return '';
	}

	try {
		return DOMPurify.sanitize(html, MARKDOWN_SANITIZE_CONFIG);
	} catch {
		// No partial output and no fallback to the raw `html`: an exception means
		// the sanitizer did not finish, so nothing it produced can be trusted.
		return '';
	}
}
