# Notes

A local-first notes app that runs entirely in your browser: notes are created, edited and stored
on your device (IndexedDB), with no accounts, no backend and no sync.

This repository currently contains the **scaffold only** — the app shell that later work is built
on: SvelteKit as a client-only SPA, Tailwind CSS v4 + shadcn-svelte components, and the full
lint / type-check / unit / E2E / CI toolchain.

## Tech stack

- [SvelteKit 2](https://svelte.dev/docs/kit) + [Svelte 5](https://svelte.dev/docs/svelte/overview) (runes) + TypeScript (strict)
- [`@sveltejs/adapter-static`](https://svelte.dev/docs/kit/adapters#supported-environments-static-sites) as a client-only SPA (`ssr = false`, `fallback: index.html`)
- [Tailwind CSS v4](https://tailwindcss.com) + [shadcn-svelte](https://www.shadcn-svelte.com/) (generated components in `src/lib/components/ui/`)
- [Vitest](https://vitest.dev) + [@testing-library/svelte](https://testing-library.com/docs/svelte-testing-library/intro) for unit/component tests
- [Playwright](https://playwright.dev) for end-to-end tests on three viewports (mobile 375×667, tablet 768×1024, desktop 1280×800)

## Prerequisites

- **Node.js 26 LTS** (see `.nvmrc`; `engines` requires `>=22`)
- **pnpm 10** — the exact version is pinned in `package.json` (`packageManager`). Recent pnpm
  installs honour that pin automatically; if yours does not, run
  `corepack enable && corepack prepare pnpm@10.34.9 --activate` (or `npm i -g pnpm@10`).

No environment variables, secrets or cloud accounts are needed.

## Run locally

```sh
pnpm install --frozen-lockfile
pnpm dev            # http://localhost:5173
```

## Test

```sh
pnpm test           # unit/component tests (Vitest + jsdom, single run)
pnpm test:watch     # same, watch mode
pnpm check          # svelte-check (TypeScript + Svelte diagnostics)

pnpm exec playwright install chromium   # once, downloads the browser
pnpm test:e2e       # builds, serves the static build and runs Playwright
```

`pnpm test:e2e` starts its own server (`pnpm build && pnpm preview`), so no dev server needs to be
running. Playwright runs every spec in the `mobile`, `tablet` and `desktop` projects. The preview
port defaults to 4173; set `E2E_PORT` when another checkout is already using it (parallel
worktrees do this — with a fixed port the suite would reuse the other server and test the wrong
build).

Screenshots for UI pull requests (375×667, 768×1024, 1280×800) are captured on demand into
`docs/screenshots/`:

```sh
SCREENSHOTS=1 pnpm test:e2e
```

## Build

```sh
pnpm build          # static SPA in build/, with build/index.html as the fallback
pnpm preview        # serve build/ on http://localhost:4173
```

`pnpm preview` runs a small stdlib-only static server (`scripts/preview.mjs`) instead of
`vite preview`: for a SvelteKit project the latter serves `.svelte-kit/output/client` plus a
server-rendered fallback that does not contain `index.html`. That 404s the precached shell and the
service worker never installs, so the app would never work offline. The static server serves
exactly the files in `build/` — like the static host this SPA is built for.

## PWA: installing and working offline

The app is an installable PWA: it registers a service worker built by
[`@vite-pwa/sveltekit`](https://vite-pwa-org.netlify.app/frameworks/sveltekit) and ships a web app
manifest, so Chrome offers **Install app** and the app keeps working with no network after one
visit, including deep links such as `/notes/<id>`.

**The service worker is disabled in `pnpm dev` and enabled in `pnpm build && pnpm preview`.**
That is deliberate: a service worker in dev serves stale caches and makes you debug a build that no
longer exists. Verify PWA behaviour against the preview server, which browsers treat as a secure
context on `localhost`:

```sh
pnpm build
pnpm preview        # http://localhost:4173 — installable, offline-capable
```

Two behaviours worth knowing:

- **Updates are prompt-only.** When a new build is deployed the app shows a "A new version is
  available" toast with a **Reload** action. Nothing reloads on its own — a reload while you are
  typing would lose the in-flight text.
- **Persistent storage is requested on first load** (`navigator.storage.persist()`) so the browser
  is less likely to evict your notes. If the browser declines, nothing is shown; the one-time
  storage notice explains that notes live only in this browser.

### Icons

Icons are generated from `static/icon.svg` and committed, so builds never need the generator:

```sh
pnpm generate:icons  # static/icon.svg → pwa-192, pwa-512, maskable 512, apple-touch-180
```

This is a normal CLI script, not an install hook: no dependency runs scripts during install.

## Lint and format

```sh
pnpm lint           # prettier --check + eslint
pnpm format         # prettier --write
```

## Project layout

```
src/routes/                  # pages (+layout.svelte, +page.svelte)
src/routes/+layout.ts        # SPA mode: ssr = false, prerender = false
src/lib/components/ui/       # shadcn-svelte generated components
src/lib/components/          # app components (added by later work)
src/lib/notes/               # notes data model and storage (added by later work)
tests/unit/                  # Vitest specs
tests/e2e/                   # Playwright specs
tests/setup/                 # Vitest setup file
```

## Adding shadcn-svelte components

```sh
pnpm exec shadcn-svelte add <component>
```

Configuration lives in `components.json`; global styles and CSS variables in `src/routes/layout.css`.

## CI

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`: install
(`--frozen-lockfile`), lint, type-check, unit tests, build, then Playwright Chromium and the E2E
suite. The Playwright report is uploaded as an artifact when the job fails.
