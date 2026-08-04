/**
 * Whether the app window is allowed to navigate somewhere.
 *
 * `setWindowOpenHandler` decides what may open in a *new* window. Nothing
 * decided what may replace the *existing* one, and the default is to allow it:
 * a URL or a file dropped on any region the renderer does not handle is
 * navigated to, replacing the app with that page. With `autoHideMenuBar` there
 * is then no back button and no reload — the app is simply gone until it is
 * restarted.
 *
 * The reason this is a boundary rather than a papercut is that the preload is
 * attached to the webContents, not to the document: `contextBridge` re-runs for
 * every top-level document loaded in the window, so whatever navigated in
 * inherits the entire `window.vault` API — reading the vault, deleting from it,
 * opening paths, and spending the user's API key on drafts. The renderer is
 * careful never to navigate (see `Markdown.tsx`), but that is a convention held
 * in several files, and this is the one place it can be enforced.
 *
 * Free of electron imports so it can be tested without booting one.
 */
export function isInAppNavigation(target: string, current: string): boolean {
  let to: URL;
  let here: URL;
  try {
    to = new URL(target);
    here = new URL(current);
  } catch {
    // An unparseable URL is not the app navigating within itself.
    return false;
  }

  if (to.protocol !== here.protocol) return false;

  // Every file: URL shares the opaque origin "null", so comparing origins here
  // would call any local file same-origin as any other — and the packaged build
  // is exactly the case that loads over file:, so that would leave the shipped
  // app unguarded against a dropped .html. Compare the path instead.
  if (to.protocol === "file:") return to.pathname === here.pathname;

  // Dev runs against the Vite server, whose reloads and full HMR refreshes
  // navigate to the app's own origin and have to survive this.
  return to.origin === here.origin;
}
