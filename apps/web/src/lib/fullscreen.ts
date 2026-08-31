/**
 * Fullscreen, and landscape while you are in it.
 *
 * A phone in portrait shows the table as a narrow strip with the browser's
 * address bar eating the top of it. Going fullscreen and locking to landscape
 * turns a handset into a usable table.
 *
 * The orientation lock is deliberately tied to fullscreen rather than offered
 * separately: browsers only honour `ScreenOrientation.lock` while the document
 * is fullscreen, and they drop the lock the moment you leave. Exposing them as
 * one control means the UI cannot promise a rotation it is not allowed to
 * perform.
 *
 * Support is uneven and the failures are silent, so every call here is
 * defensive:
 *
 * - Android Chrome: both work.
 * - Desktop: fullscreen works, the lock rejects. Harmless -- a desktop window
 *   is landscape already.
 * - iOS Safari: neither is available on a normal element. The button hides
 *   itself rather than offering something that does nothing.
 */

/** `lock`/`unlock` are not in the DOM types everywhere yet. */
type LockableOrientation = ScreenOrientation & {
  lock?: (orientation: 'landscape' | 'portrait' | 'natural' | 'any') => Promise<void>;
  unlock?: () => void;
};

export function fullscreenSupported(): boolean {
  return (
    typeof document !== 'undefined' &&
    // `fullscreenEnabled` is false inside an iframe without allowfullscreen,
    // and undefined on iOS Safari -- both mean "do not offer this".
    document.fullscreenEnabled === true &&
    typeof document.documentElement.requestFullscreen === 'function'
  );
}

export function isFullscreen(): boolean {
  return typeof document !== 'undefined' && document.fullscreenElement !== null;
}

/**
 * Ask for landscape. Never throws.
 *
 * A rejection is the normal case on desktop and on any browser that has not
 * implemented the lock, and it must not stop the user going fullscreen -- the
 * fullscreen part is useful on its own.
 */
async function lockLandscape(): Promise<void> {
  const orientation = globalThis.screen?.orientation as LockableOrientation | undefined;
  try {
    await orientation?.lock?.('landscape');
  } catch {
    /* not supported, or refused: fullscreen without the rotation is still fine */
  }
}

function unlockOrientation(): void {
  const orientation = globalThis.screen?.orientation as LockableOrientation | undefined;
  try {
    orientation?.unlock?.();
  } catch {
    /* ignore */
  }
}

/**
 * Enter fullscreen and turn the phone sideways.
 *
 * Must be called from a user gesture -- browsers reject a fullscreen request
 * that did not come from a click or tap.
 */
export async function enterFullscreen(target: Element = document.documentElement): Promise<void> {
  await target.requestFullscreen();
  // Only after the request resolves: the lock is rejected while the document
  // is not yet fullscreen.
  await lockLandscape();
}

export async function exitFullscreen(): Promise<void> {
  // Released first. Leaving fullscreen drops the lock anyway, but doing it in
  // this order avoids a frame where the page is windowed and still rotated.
  unlockOrientation();
  if (document.fullscreenElement) await document.exitFullscreen();
}
