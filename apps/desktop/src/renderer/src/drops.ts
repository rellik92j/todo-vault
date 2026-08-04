/**
 * Reading what a drag actually carried.
 *
 * A file dragged from Explorer arrives as `dataTransfer.files`. A document
 * dragged out of the OneDrive web UI does not — the browser hands over a URL
 * and nothing else, so a handler that only looks at `files` treats the whole
 * gesture as a no-op. That silent nothing is what this exists to fix.
 */

/**
 * Pull usable URLs out of a `text/uri-list` payload.
 *
 * The format (RFC 2483) is one URL per line with `#` comment lines, and
 * browsers vary on whether they send CRLF. Everything that is not an
 * http(s)-shaped URL is dropped here rather than at the point of use, so the
 * caller can treat an empty array as "this drag carried nothing we can link".
 */
export function parseUriList(payload: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of payload.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    // Anything that is not a URL at all — and, deliberately, anything that is
    // a URL with a scheme the main process would refuse to open — is skipped,
    // so a drop cannot write a link that is dead on arrival.
    let url: URL;
    try {
      url = new URL(line);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;

    if (seen.has(url.href)) continue;
    seen.add(url.href);
    out.push(line);
  }

  return out;
}
