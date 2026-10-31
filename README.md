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
running. Playwright runs every spec in the `mobile`, `tablet` and `desktop` projects.

Screenshots for UI pull requests (375×667, 768×1024, 1280×800) are captured on demand into
`docs/screenshots/`:

```sh
SCREENSHOTS=1 pnpm test:e2e
```

## Build

```sh
pnpm build          # static SPA in build/, with build/index.html as the fallback
pnpm preview        # serve the built output on http://localhost:4173
```

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
