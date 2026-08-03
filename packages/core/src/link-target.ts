/**
 * What a link target looks like it points at, decided from the string alone.
 *
 * Kept apart from `links.ts` — which needs `node:path` for the sync-root
 * comparison — so the renderer can import it. The desktop renderer is
 * sandboxed and bundles for Chromium, so anything it imports from the core has
 * to be free of node built-ins, the same reason `constants` and `recurrence`
 * are their own leaves.
 */

/**
 * `sharepoint` is kept distinct from `onedrive` because the hostname sniff can
 * tell them apart and they are different products — but they share the
 * property this feature cares about: one authoritative copy living on a
 * server, which a local duplicate immediately starts diverging from.
 *
 * This is a *guess from the string*, never a hard rule. A wrong silent guess
 * is worse than no guess, so callers surface it as a default the user can
 * override rather than as a refusal.
 */
export type LinkTargetKind = "onedrive" | "sharepoint" | "url" | "path";

/** Consumer OneDrive hosts. Business is matched by the `-my` suffix rule below. */
const CONSUMER_HOSTS = new Set(["onedrive.live.com", "1drv.ms"]);

/**
 * Deep links produced by some "Copy link" menus, which open the OneDrive
 * client rather than a browser. They are not http, so the hostname rules
 * below never see them.
 */
const ONEDRIVE_SCHEMES = new Set(["odopen:", "ms-onedrive:"]);

export function classifyLinkTarget(target: string): LinkTargetKind {
  const trimmed = target.trim();
  if (!trimmed) return "path";

  // `new URL("C:\\Users\\me\\plan.xlsx")` succeeds — a drive letter parses as a
  // scheme — so Windows paths have to be ruled out before the parse is trusted.
  // UNC paths (`\\server\share`) throw and fall through to the catch.
  if (/^[a-z]:[\\/]/i.test(trimmed)) return "path";

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "path";
  }

  if (ONEDRIVE_SCHEMES.has(url.protocol)) return "onedrive";

  const host = url.hostname.toLowerCase();
  if (CONSUMER_HOSTS.has(host)) return "onedrive";
  // `contoso-my.sharepoint.com` is OneDrive for Business; `contoso.sharepoint.com`
  // is a document library — same don't-copy property, different product.
  if (host.endsWith("-my.sharepoint.com")) return "onedrive";
  if (host.endsWith(".sharepoint.com")) return "sharepoint";

  return "url";
}
