# Plan: openable file/folder links, and OneDrive links that stay in OneDrive

Two asks, which are less related than they look:

1. **`file` and `folder` links should be clickable** — clicking opens the target,
   the way a `url` link already does. Same for the attachment rows.
2. **A OneDrive file should be linkable as OneDrive.** When the target is a
   OneDrive file, the vault records the OneDrive URL and never copies the file
   into `attachments/`, because a copy immediately becomes a second, diverging
   version of a document whose whole point is that it has one version.

Ask 2 is the one with the traps in it. Read the *Problems and gotchas* section
before writing any code — three of them change what should be built.

> **Status: ask 1 is built, ask 2 is not.** Steps 1–2 of the build order shipped —
> the scheme allowlist and the `openTarget` channel, so `file` and `folder` links
> and attachment rows open on click. Everything about OneDrive below (steps 3–5,
> and gotchas 1–3 and 9–11) is still a design, not a description. The table below
> is left as it was written, as the record of what the code looked like before.

## Where things stood before ask 1

| | |
|---|---|
| `file` / `folder` links | Rendered as dead text — label above, grey monospace path below ([ItemDetail.tsx:338](apps/desktop/src/renderer/src/ItemDetail.tsx:338)) |
| `url` links | `<a target="_blank">`, intercepted by `setWindowOpenHandler` → `shell.openExternal` ([main/index.ts:101](apps/desktop/src/main/index.ts:101)) |
| `item` links | Button that selects the other item |
| Attachments | Button that **reveals** in Explorer, does not open ([ItemDetail.tsx:374](apps/desktop/src/renderer/src/ItemDetail.tsx:374) → `CHANNELS.revealPath` → `shell.showItemInFolder`) |
| Attach from disk | `attachViaDialog(key, copy)` — "copy in" or "link in place"; `copy: false` writes a `file` link instead ([vault.ts:649](packages/core/src/vault.ts:649)) |
| Drag and drop | Always `copy: true`, hardcoded ([ItemDetail.tsx:88](apps/desktop/src/renderer/src/ItemDetail.tsx:88)) |

The first four rows are now the `openTarget` channel in `main/index.ts`, and
reveal is kept alongside open rather than replaced, per gotcha 7. The last two
are unchanged, and they are where ask 2 lives.

So the *storage* side of ask 2 already exists — `copy: false` is exactly "point
at it, don't duplicate it". What is missing is that nothing knows a OneDrive path
when it sees one, and the path that most often creates the unwanted copy (drag
and drop) never offers the choice.

## Problems and gotchas

### 1. "OneDrive link" means three different things

- **A synced local path** — `C:\Users\bisch\OneDrive - Contoso\Docs\plan.xlsx`.
  A perfectly ordinary filesystem path. Opens offline, opens in the desktop app,
  and is *machine-specific*: it names one user's profile on one PC and resolves
  nowhere else.
- **A web share URL** — `https://contoso-my.sharepoint.com/:x:/g/personal/…?e=AbC123`.
  Portable, opens in the browser or hands off to the desktop app, and carries a
  sharing token in the query string.
- **`odopen://` / `ms-onedrive:` deep links** produced by some "Copy link"
  menus, which open the OneDrive client rather than a browser.

The ask is written as though only the second exists. But the copy the user is
trying to prevent is created by the **first** — you cannot drag a browser URL
into a file dialog, and `attachPaths` only ever receives filesystem paths. **If
detection only looks at URLs, the feature will not prevent a single unwanted
copy.** Detection has to sit in the local-path branch of `addAttachment` too.

### 2. Detecting a synced OneDrive folder is machine-local and Windows-shaped

The reliable signals are the `OneDrive`, `OneDriveCommercial` and
`OneDriveConsumer` environment variables, plus `HKCU:\Software\Microsoft\OneDrive\Accounts\*\UserFolder`.
All are per-machine, per-user, and Windows-only. `packages/core` is cross-platform
and imports nothing platform-specific for policy decisions — hardcoding a
registry read there is wrong. Pass the known sync roots **into** the core as an
option (`VaultOptions.syncedRoots?: string[]`), and let the desktop main process
be the thing that knows how to find them. The CLI and MCP server then simply
don't get the behaviour unless configured, which is the honest outcome.

Detecting by *hostname* is likewise a heuristic. `*-my.sharepoint.com` is
OneDrive for Business; `contoso.sharepoint.com` (no `-my`) is a SharePoint
document library, which has the same don't-copy property but is not OneDrive;
`onedrive.live.com` and `1drv.ms` are consumer. Treat the sniff as **a default
the user can override in the dropdown**, never as a silent hard rule. A wrong
silent guess is worse than no guess.

### 3. Adding `onedrive` to `LINK_TYPES` breaks older builds' reading of the vault

`SCHEMA.md` promises unknown *fields* survive a round-trip through an older
build. It says nothing about unknown *enum values*, and they do not survive:
`LinkSchema.type` is a `z.enum`, so an older app opening a vault containing a
`onedrive` link fails to parse the whole item, and the item lands in
`snapshot.errors` and disappears from every view. That is a data-visibility
regression for anyone running two versions (which is the normal state while the
desktop app and a globally-installed MCP server drift apart).

**Recommendation: do not add a link type.** Store OneDrive links as `type: url`
and recognise them by target. Zero migration, the Jira push already treats `url`
correctly ([jira.ts:346](packages/core/src/jira.ts:346)), and the CLI, MCP tool
descriptions and `SCHEMA.md` table need no changes. The only thing a distinct
type would buy is a different icon, and the renderer can derive that from the URL.

If a distinct type is wanted anyway, it needs a separate decision about enum
forward-compatibility (`.catch("note")` on the type field, or a passthrough
variant) and that is a schema change worth its own section in `SCHEMA.md`.

### 4. Opening a `file` link cannot use the guard that `revealPath` uses

`revealPath` deliberately refuses anything resolving outside the vault
([main/index.ts:351](apps/desktop/src/main/index.ts:351)). A `file` link is
*by definition* outside the vault — that guard cannot be reused, and copying its
shape would reject every link the feature exists to open.

What replaces it is not "nothing":

- `shell.openPath` on `.exe .bat .cmd .com .scr .msi .ps1 .vbs .js .jar .lnk .url .reg`
  **runs** the thing. A vault is a synced folder full of YAML that an MCP server,
  a CLI, and possibly another person's Claude can write to. Refuse those
  extensions, and say why, rather than opening them.
- `shell.openPath` returns an error *string* instead of throwing. Ignore the
  return value and a missing file produces a click that does nothing at all.
  Surface it: "plan.xlsx is not on disk (E:\ is not mounted)".
- UNC paths (`\\server\share\…`) can block for many seconds when the share is
  unreachable. The handler is async so the window survives, but the UI should
  show that a click was registered.

### 5. The existing `url` path has no scheme check at all

`setWindowOpenHandler` hands **any** href to `shell.openExternal`. A link with
target `file:///C:/Windows/System32/…`, `javascript:…`, `ms-msdt:…` or
`search-ms:…` is a live local-code-execution vector, and link targets are
attacker-reachable via the MCP server and via hand-edited frontmatter. This is a
pre-existing hole, but ask 2 makes it worse by encouraging pasted URLs from
outside. **Allowlist `http:`, `https:`, `mailto:` at that handler** — and add
`ms-onedrive:`/`odopen:` deliberately if deep links are wanted, as a decision
rather than as a side effect.

### 6. `<a href>` will not work for file paths

`<a href="C:\Users\…">` is not a URL; Electron will try to navigate the window
and fail. "Hyperlink" here means *styled as a link, dispatched over IPC* — the
existing `.link-btn` class already gives a `<button>` the right look, so this is
a rendering-branch change, not a CSS one.

### 7. Attachments currently *reveal*, and reveal is worth keeping

Making the attachment title open the file removes the only route to its
containing folder. Keep both: title opens, the grey path line underneath becomes
the reveal affordance. (Unrelated but visible once this area is touched:
attachment rows have no remove button and `Vault` has no `removeAttachment` —
detaching is a hand-edit today. Out of scope, worth logging.)

### 8. `removeLink` matches on target alone

[vault.ts:616](packages/core/src/vault.ts:616) removes every link with that
target regardless of type, while `addLink` dedupes on `(type, target)` — so the
same URL can exist as two links and one ✕ deletes both. Adding a second
URL-shaped link type (see gotcha 3) makes that collision likely rather than
theoretical. Another reason to prefer `type: url`.

### 9. Folders are second-class in the attach path

`addAttachment` rejects anything that is not a file ([vault.ts:645](packages/core/src/vault.ts:645))
and `attachViaDialog` opens a file-only picker, so a `folder` link can only be
created by typing the path into the link form — and **dropping a folder onto the
detail panel throws**, failing the whole drop. If folder links are becoming
first-class enough to click, they need a picker (`properties: ["openDirectory"]`)
and the drop handler needs to route directories to `folder` links instead of
erroring.

### 10. Dragging from the OneDrive web UI drops a URL, not a file

`dataTransfer.files` is empty and the handler silently returns
([ItemDetail.tsx:86](apps/desktop/src/renderer/src/ItemDetail.tsx:86)). Reading
`dataTransfer.getData("text/uri-list")` turns that dead gesture into the single
most natural way to create a OneDrive link.

### 11. Sharing URLs carry access tokens, and the vault may be a git repo

`?e=`, `?d=`, `guestaccess.aspx` links are capability URLs: possession is
permission, subject to the share's audience. The vault commits every write when
`--git` is on, and that repo may have a remote. Worth a one-line note in
`SCHEMA.md` rather than a mechanism — but it should be a decision made knowingly.

### 12. Drift

`sync.contentHash` covers pushed fields, and links are pushed (they appear in the
description footer). Adding links to already-pushed items flips them to
`drifted`. Correct behaviour, but expect the board to light up after a session
of adding links.

## Proposed shape

**Core (`packages/core`)**

- `VaultOptions.syncedRoots?: string[]` — absolute paths whose contents must
  never be copied. Empty by default, so CLI/MCP behaviour is unchanged.
- `addAttachment` gains a rule: when `copy: true` and the source is under a
  synced root, do not copy. Two candidate behaviours — **refuse with a message
  naming the alternative**, or **silently downgrade to `copy: false`**. Prefer
  refusing in core and downgrading in the app's drop handler, so the API stays
  honest and the gesture stays smooth.
- `isSyncedPath(abs, roots)` and `classifyLinkTarget(target)` exported as pure
  helpers, so the URL heuristic is testable without a filesystem.
- No schema change. No new link type. `SCHEMA.md` gains a paragraph under
  *Links* explaining the OneDrive rule and why.

**Main process (`apps/desktop/src/main`)**

- New channel `openTarget({ kind: "attachment" | "file" | "folder" | "external", value })`:
  - `attachment` → resolve under the vault, keep the existing containment check, `shell.openPath`
  - `file` / `folder` → extension refusal list, existence check, `shell.openPath`, return the error string
  - `external` → scheme allowlist, `shell.openExternal`
- `revealPath` stays exactly as it is.
- Scheme allowlist added to `setWindowOpenHandler`.
- Discover OneDrive roots once at startup (env vars first, registry as fallback)
  and pass them to `Vault` as `syncedRoots`.
- `attachViaDialog` gains a directory mode.

**Renderer**

- `file` / `folder` link rows and attachment titles become `.link-btn` buttons
  wired to `openTarget`; the path line becomes the reveal affordance.
- Link form: a **"OneDrive"** option that is still `type: url` underneath, with
  a paste field that validates the URL and warns on a non-OneDrive host instead
  of refusing it.
- Drop handler: read `text/uri-list` when there are no files; route directories
  to `folder`; route synced-root files to a link rather than a copy, with a
  visible note saying that is what happened and why.
- Failed opens surface as the existing error toast rather than a dead click.

**Tests** (`packages/core/test/vault.test.ts` — 53 green today, keep it green)

`isSyncedPath` on nested/sibling/case-differing roots; `classifyLinkTarget`
across the three OneDrive URL shapes plus a plain SharePoint library and a
non-match; `addAttachment` refusing to copy from a synced root and still
accepting `copy: false`; the extension refusal list; unchanged behaviour when
`syncedRoots` is empty.

## Order to build it

1. ✅ Scheme allowlist on `setWindowOpenHandler` — smallest, and closes a live
   hole. It also guards links inside a rendered description, which arrived after
   this was written and can be authored by anything with a text editor.
2. ✅ `openTarget` channel + clickable `file`/`folder`/attachment rows. This is
   ask 1 whole, and it does not depend on anything below.
3. `classifyLinkTarget` + the OneDrive option in the link form. Ask 2, web half.
4. `syncedRoots` + the `addAttachment` rule + the drop-handler routing. Ask 2,
   local half — the part that actually prevents the diverging copy.
5. Folder picker and directory drops (gotcha 9), if still wanted once 2 lands.

Steps 1–2 are worth landing on their own; 3–4 should land together, because
shipping 3 alone produces a feature that looks finished and prevents nothing.
