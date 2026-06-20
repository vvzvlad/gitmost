# HTML embed (admin-only) — workspace feature toggle

The `htmlEmbed` node lets a workspace **admin/owner** embed raw HTML/CSS/JS that
**executes in the wiki page origin** for everyone who views the page. This is a
deliberate stored-XSS surface (e.g. for analytics trackers / third-party
widgets). It is gated behind a per-workspace feature toggle that is **OFF by
default**.

## Behavior

- **OFF by default.** A fresh/unconfigured workspace has the feature disabled
  (`settings.htmlEmbed` absent or `false`). With the toggle OFF, htmlEmbed is
  stripped on every save for **everyone, including admins** — the feature is
  fully disabled.
- **Only admins/owners can insert.** When the toggle is ON, the `/html` slash
  item (and the embed editor) is offered only to workspace admins/owners.
  Members never see it. The gate is **toggle AND admin**.
- **Server strips on every write path (fail-closed).** The UI gate is a
  convenience only. The server independently strips htmlEmbed nodes from every
  write where the gate is not satisfied. If a **non-admin** edits and saves a
  page that contains an admin's embed, that save **strips the embed** — the
  admin must re-add it. Same if the toggle is OFF.
- **Turning the toggle OFF neutralizes existing embeds.** Existing embeds are
  stripped on their next save (collab store / REST / etc.), and the client
  NodeView stops executing them immediately, rendering a disabled placeholder
  instead (defense in depth at render time).

## Storage

The toggle lives in the workspace `settings` jsonb at the top level:
`settings.htmlEmbed` (boolean). ABSENT/`false` => OFF.

- Update field: `htmlEmbed: boolean` on `UpdateWorkspaceDto`.
- Persisted by `WorkspaceService.update` via
  `WorkspaceRepo.updateSetting(workspaceId, 'htmlEmbed', value)` (top-level
  scalar settings key; analogous to `updateAiSettings`). The change is
  audit-logged like the AI toggles.

## Server gate

`apps/server/src/common/helpers/prosemirror/html-embed.util.ts`:

```ts
// Allowed only when the workspace feature toggle is ON and the user is admin/owner.
export function htmlEmbedAllowed(featureEnabled: boolean, role): boolean {
  return featureEnabled === true && canAuthorHtmlEmbed(role);
}
// settings.htmlEmbed === true (ABSENT/non-true => OFF).
export function isHtmlEmbedFeatureEnabled(settings): boolean { ... }
```

Every write-path gate site reads the workspace's setting
(`workspace.settings?.htmlEmbed === true`, via `WorkspaceRepo.findById`) and
applies `!htmlEmbedAllowed(featureEnabled, role)` before persisting. The 7 sites:

- `core/page/services/page.service.ts` — `create()` and `duplicatePage()`
- `collaboration/extensions/persistence.extension.ts` — collab store
- `collaboration/collaboration.handler.ts` — REST/MCP/AI content update
- `integrations/import/services/import.service.ts` — single import
- `integrations/import/services/file-import-task.service.ts` — zip import
- `core/page/transclusion/transclusion.service.ts` — transclusion unsync

## Client

- Slash menu: the `/html` item carries `requiresHtmlEmbedFeature: true` and
  `adminOnly: true`; it is hidden unless the persisted
  `workspace.settings.htmlEmbed === true` AND the user is admin. The slash
  function reads the toggle from the persisted `currentUser` localStorage entry
  (same mechanism as `isCurrentUserAdmin()`).
- NodeView (`html-embed-view.tsx`): only executes the raw HTML/JS when the
  toggle is ON; otherwise renders a neutral "HTML embed is disabled in this
  workspace" placeholder and injects nothing.
- Admin UI: a Switch in **Workspace Settings → General** (`HtmlEmbedSettings`)
  toggles the feature with an optimistic `updateWorkspace({ htmlEmbed })`, with a
  description documenting the security implications.
