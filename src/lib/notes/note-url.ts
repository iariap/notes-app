/**
 * Rewrites `/notes/new` to `/notes/<id>` in place.
 *
 * Isolated in its own module for one reason: it is the only place the editor
 * touches the router, so a test can replace it with a spy and assert both the
 * address bar and — more importantly — that the component was *not* remounted
 * by the change (the shallow history update below never asks the router to
 * navigate, so the textarea, its focus and its caret survive untouched).
 */
import { replaceState } from '$app/navigation';
import { resolve } from '$app/paths';

export function replaceNoteUrl(id: string): void {
	replaceState(resolve('/notes/[id]', { id }), {});
}
