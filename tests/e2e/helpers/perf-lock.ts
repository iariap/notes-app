import { mkdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * A cross-process, cross-project mutex for the 1,000-note benchmarks.
 *
 * ## The problem this solves
 *
 * `tests/e2e/acceptance/performance.spec.ts` and `tests/e2e/notes-list-perf.spec.ts`
 * both seed 1,000 notes and gate a **subtractive** delta
 * (`seeded median − empty median`). A seeded render costs roughly 3× the CPU of
 * an empty one, so when two of those benchmarks overlap the machine is loaded
 * unevenly: contention inflates the seeded side more than the empty side, and the
 * delta no longer cancels. Measured on this repository: 121–129 ms marginal when
 * the benchmarks run alone, **509 ms under 6× CPU throttling with 8 concurrent
 * workers** — past the 500 ms budget, with the property itself unchanged. On the
 * real CI runner (empty baseline 136 ms vs 25 ms locally) that is what turned
 * two PRs red in the full matrix.
 *
 * With `fullyParallel: true` there are up to **three** such benchmarks alive at
 * once: `notes-list-perf.spec.ts` in the `desktop` and `tablet` projects plus
 * `acceptance/performance.spec.ts` in `desktop`, and each file's *own* tests can
 * also land in different workers of the same project.
 *
 * ## Why a file lock and not `test.describe.configure({ mode: 'serial' })`
 *
 * `mode: 'serial'` orders tests **within one file, in one project, in one
 * worker**. It cannot stop the `desktop` copy of one file from overlapping the
 * `tablet` copy of another, which is exactly the overlap that caused the CI
 * failures — the `desktop` run failed while `tablet` passed *in the same run*.
 * A worker-scoped fixture has the same limitation: fixtures are per worker
 * process, so two workers never share one.
 *
 * The lock is therefore a **directory on disk**, created with a non-recursive
 * `mkdir` (atomic on POSIX and on Windows): whoever creates it first holds it,
 * and everybody else gets `EEXIST` and waits. That is the only primitive here
 * that is genuinely shared by separate OS processes, so it is what makes the
 * two files mutually exclusive across projects and across worker processes.
 *
 * `mode: 'serial'` was also rejected on its own merits: a serial group *skips the
 * remaining tests when one fails*, which would hide the scrolling benchmark
 * whenever the render benchmark went red — they are independent properties and
 * both should report.
 *
 * ## Stale locks
 *
 * A worker killed by a test timeout (or a `SIGKILL`) never runs its `finally`,
 * so the lock would outlive it and deadlock the rest of the suite. Two guards:
 * the lock records the holder's pid and start time, and a waiter may break a lock
 * older than `STALE_MS` — comfortably longer than any benchmark's own timeout, so
 * a genuinely slow holder is never evicted.
 */

/** Directory name inside `test-results/`. The parent is gitignored and writable. */
const LOCK_DIR = path.resolve(import.meta.dirname, '../../test-results/.perf-benchmark');

/**
 * How long a waiter tolerates a held lock before giving up.
 *
 * Must exceed `STALE_MS` so that a waiter always reaches the staleness check
 * before it errors out — otherwise a lock orphaned by a killed worker would make
 * every other project fail with "timed out waiting" instead of being reclaimed.
 */
const ACQUIRE_TIMEOUT_MS = 420_000;

/**
 * A lock older than this was left by a dead process and may be broken.
 *
 * Must be comfortably longer than the benchmark's own timeout (240 s, set by
 * `test.setTimeout` in both specs) so a genuinely slow holder is never evicted
 * mid-measurement, and shorter than `ACQUIRE_TIMEOUT_MS` so a waiter reclaims it
 * rather than throwing. 300 s sits between the two with room on both sides.
 */
const STALE_MS = 300_000;

/** First retry delay; doubles up to `MAX_BACKOFF_MS`. Keeps polling cheap. */
const MIN_BACKOFF_MS = 50;
const MAX_BACKOFF_MS = 2_000;

interface LockOwner {
	pid: number;
	label: string;
	startedAt: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function readOwner(): Promise<LockOwner | undefined> {
	try {
		return JSON.parse(await readFile(path.join(LOCK_DIR, 'owner.json'), 'utf8')) as LockOwner;
	} catch {
		// The winner creates the directory before writing its metadata, so a
		// lock with no readable owner is a lock that was *just* taken. Treated as
		// live; the staleness check is what eventually reclaims it if not.
		return undefined;
	}
}

/** Tries to take the lock exactly once. `true` means this process owns it now. */
async function tryAcquire(label: string): Promise<boolean> {
	try {
		// NOT `recursive: true` on the lock itself: recursion swallows `EEXIST`,
		// which is the whole point of using `mkdir` as the atomic primitive.
		await mkdir(path.dirname(LOCK_DIR), { recursive: true });
		await mkdir(LOCK_DIR);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
		throw error;
	}
	const owner: LockOwner = { pid: process.pid, label, startedAt: Date.now() };
	await writeFile(path.join(LOCK_DIR, 'owner.json'), JSON.stringify(owner), 'utf8');
	return true;
}

/** Removes a lock nobody is holding any more. Best effort: another waiter may win. */
async function breakIfStale(): Promise<boolean> {
	let age: number;
	try {
		// The directory's own mtime is the creation time; the metadata file is
		// written immediately after, so this is within a millisecond of the truth.
		age = Date.now() - (await stat(LOCK_DIR)).mtimeMs;
	} catch {
		// Vanished between the failed acquire and here: try again immediately.
		return true;
	}
	if (age < STALE_MS) return false;

	const owner = await readOwner();
	// A live holder refreshes nothing, so age is the only signal available. Erring
	// towards breaking after `STALE_MS` is deliberate: a stuck suite is worse than
	// one benchmark measured alongside another, and `STALE_MS` dwarfs any timeout.
	try {
		await rm(path.join(LOCK_DIR, 'owner.json'), { force: true });
		await rmdir(LOCK_DIR);
	} catch {
		return false;
	}
	console.warn(
		`[perf] broke a stale benchmark lock (${age} ms old, held by pid ${owner?.pid ?? 'unknown'} "${owner?.label ?? '?'}")`
	);
	return true;
}

/**
 * Runs `fn` with exclusive access to the machine's CPU for a 1,000-note
 * benchmark. Every other process calling this waits until it returns.
 *
 * `label` is only used for diagnostics — it names the holder in the lock
 * metadata and in the "breaking a stale lock" warning, so a stuck CI job says
 * *which* benchmark was holding it.
 */
export async function withPerfBenchmarkLock<T>(label: string, fn: () => Promise<T>): Promise<T> {
	const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
	let backoff = MIN_BACKOFF_MS;

	while (!(await tryAcquire(label))) {
		if (await breakIfStale()) continue;
		if (Date.now() > deadline) {
			const owner = await readOwner();
			throw new Error(
				`Timed out after ${ACQUIRE_TIMEOUT_MS} ms waiting for the 1,000-note benchmark lock ` +
					`(held by pid ${owner?.pid ?? 'unknown'} "${owner?.label ?? '?'}" ` +
					`since ${owner ? new Date(owner.startedAt).toISOString() : 'unknown'}). ` +
					`Delete ${LOCK_DIR} if that process is gone.`
			);
		}
		await sleep(backoff);
		backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
	}

	try {
		return await fn();
	} finally {
		// Released even when the benchmark throws, so one failure cannot wedge the
		// remaining projects. If this process is killed outright the stale check
		// reclaims the lock instead.
		await rm(LOCK_DIR, { recursive: true, force: true });
	}
}
