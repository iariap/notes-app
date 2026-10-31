#!/usr/bin/env node
/**
 * Static SPA server for the production build: `pnpm build && pnpm preview`.
 *
 * This app is a client-only SPA (`ssr = false`) that ships as plain files, so
 * previewing it must serve exactly those files. `vite preview` cannot: for a
 * SvelteKit project it serves `.svelte-kit/output/client` plus a server-rendered
 * fallback that does not contain `index.html` at all and rewrites asset URLs
 * relative to the current path. Both break the PWA — the service worker's
 * precache manifest references `/index.html`, which would 404, so the worker
 * never finishes installing and the app is never offline-capable.
 *
 * Usage: `node scripts/preview.mjs [--port 4173] [--host 127.0.0.1]`.
 * The port is strict: if it is taken the process fails instead of drifting to
 * another one, so a test run can never silently measure someone else's build.
 *
 * Deliberately stdlib-only: no dependency, no install script, ~100 lines that
 * any static host's behaviour can be reasoned about from.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../build');
const INDEX = join(ROOT, 'index.html');

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.webmanifest': 'application/manifest+json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.webp': 'image/webp',
	'.woff2': 'font/woff2',
	'.txt': 'text/plain; charset=utf-8',
	'.map': 'application/json; charset=utf-8'
};

function flag(name, fallback) {
	const index = process.argv.indexOf(`--${name}`);
	if (index === -1) return fallback;
	const value = process.argv[index + 1];
	return value && !value.startsWith('--') ? value : fallback;
}

const port = Number(flag('port', process.env.PORT ?? 4173));
const host = flag('host', process.env.HOST ?? '127.0.0.1');

/** Maps a URL path to a file inside `build/`, or to `undefined` when it escapes. */
function resolveFile(pathname) {
	const decoded = decodeURIComponent(pathname);
	const target = normalize(join(ROOT, decoded));
	if (target !== ROOT && !target.startsWith(ROOT + sep)) return undefined;
	return target;
}

async function isFile(path) {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

/**
 * A request that names a file (has an extension) must exist: answering it with
 * the SPA shell would hand a broken response to the service worker's precache
 * and surface, much later, as "the app mysteriously does not work offline".
 * Extension-less paths are client routes and get the shell.
 */
async function findFile(pathname) {
	const candidate = resolveFile(pathname);
	if (!candidate) return undefined;
	if (await isFile(candidate)) return candidate;
	// `/foo/` → `/foo/index.html`
	if (await isFile(join(candidate, 'index.html'))) return join(candidate, 'index.html');
	if (extname(pathname) !== '') return undefined;
	return (await isFile(INDEX)) ? INDEX : undefined;
}

const server = createServer(async (request, response) => {
	const { pathname } = new URL(request.url ?? '/', `http://${request.headers.host ?? host}`);
	const file = await findFile(pathname === '/' ? '/index.html' : pathname);

	if (!file) {
		response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
		response.end(`404 ${pathname}\n`);
		console.log(`[404] ${request.method} ${pathname}`);
		return;
	}

	const extension = extname(file);
	response.writeHead(200, {
		'content-type': MIME[extension] ?? 'application/octet-stream',
		// Hashed assets never change; everything else (the shell, the manifest,
		// the service worker) must be revalidated so a new build is noticed and
		// the update prompt can appear.
		'cache-control': pathname.startsWith('/_app/immutable/')
			? 'public, max-age=31536000, immutable'
			: 'no-cache'
	});
	console.log(`[200] ${request.method} ${pathname}`);
	createReadStream(file).pipe(response);
});

server.on('error', (error) => {
	console.error(
		error.code === 'EADDRINUSE'
			? `Port ${port} is already in use. Choose another with --port <n>.`
			: error
	);
	process.exit(1);
});

server.listen(port, host, () => {
	console.log(`Serving build/ (static SPA) at http://${host}:${port}/`);
});
