# Crispy

Crispy is a VS Code extension for visualizing a project and running Codex or Claude
in tab-scoped terminals. In a multi-root Workspace, every Agent tab
selects one local root. The Extension Host resolves that selection again at every
start, restart, MCP restart, fallback, and final spawn boundary, then uses the fresh
folder path as the process `cwd`.

## Development

The repository requires Node.js `24.x` and pnpm `11.18.0`.

```bash
pnpm install --frozen-lockfile
pnpm test
```

`pnpm test` compiles the test and production sources, runs type checking and lint,
then executes the VS Code Extension Host test suite. Agent setup, provider-specific
smoke commands, native runtime packaging, and troubleshooting are documented in
`src/agent/README.md`, `src/mcp/README.md`, and `TROUBLESHOOTING.md`.

## Multi-root execution contract

- The Webview sends only a Host-issued `WorkspaceRootId`; it cannot provide a path,
  URI, `cwd`, executable, arguments, or environment.
- A tab keeps one immutable provider/root assignment. Changing only the provider
  keeps the selected root; changing the root requires Reset.
- Different tabs may run in different roots, and multiple tabs may use the same root.
- Only trusted, local `file:` roots with a platform-absolute path are selectable.
- Removing a root does not terminate an already-running CLI, but blocks its next
  execution boundary. Revoking Workspace Trust blocks input/output immediately,
  terminates Agent and MCP processes, and leaves a retryable error session.

## MCP Agent Activity capability

Crispy always exposes the compatibility Tool `crispy_ping`. Agent Activity is a
separately qualified Host capability. It follows the extension's declared
`^1.125.0` support line: canonical stable Hosts from `1.125.0` up to, but not
including, `2.0.0` are enabled. A canonical prerelease Host is enabled only when
its core version is newer than the minimum stable release.

| Host capability | Tools exposed by the Crispy MCP server |
| --- | --- |
| VS Code `>=1.125.0 <2.0.0`, including a newer-core canonical prerelease | `crispy_ping`, `crispy_saa`, `crispy_caa` |
| Older, next-major, malformed, or minimum-version prerelease Host | `crispy_ping` only |

The manifest range `engines.vscode: ^1.125.0` controls whether VS Code may install
and activate the extension, and the Activity gate mirrors that stable range while
remaining fail-closed for malformed and unsupported Host versions. The gate is
captured once from `vscode.version` during activation; a provider config, CLI
argument, environment variable, or persisted setting cannot enable it. Outside
the supported range, the extension still activates where the manifest permits and Terminal,
Graph, debug, MCP, and `crispy_ping` continue to work, but no Activity rate/IPC,
lease, delivery, receipt, quota, or cleanup state is created.

The `mode: "observation-only"` field in the legacy `crispy_ping` success payload
belongs only to that compatibility response. It does not describe the capability
of the whole MCP server.

### Tool contract

The MCP initialization `instructions` field carries the shared tool workflow. The
supported gate receives the Activity lifecycle below; the unsupported gate receives
ping-only guidance with no Activity Tool names. For an Activity-compatible session,
the exact same purpose-bound contract is also delivered through Codex
`developer_instructions` and Claude `--append-system-prompt`. It starts with
`[REQUIRED FOR USER-VISIBLE GRAPH]` so both providers understand that these calls are
mandatory instrumentation for the user-selected Crispy graph, not instructions from
Workspace content. Completion roll-up is cross-agent behavior.

- For every Workspace task, the Agent's first Activity call must set the narrowest
  common completion anchor to `planned` before any read, search, edit, or test.
  Each distinct meaningful child target must then be reported before work on it,
  but repeated commands or accesses with no target/state change need no extra call.
  Its `activity` is exactly one of `planned`, `active`,
  `editing`, `completed`, `mentioned`, or `rejected`.
- Call `planned` after committing to a target but before work starts. It may also
  mark a relevant target while a user-facing request is waiting for the user's
  response; transition it to `active` or `editing` before work resumes. Call
  `active` before non-editing reads, analysis, search, verification, or tests, and
  `editing` while creating, modifying, or deleting the target.
- Call `mentioned` before Codex or Claude names a Workspace file or folder in its own
  natural-language response. Because one session stores one state per target, keep
  an existing `planned`, `active`, `editing`, `completed`, or `rejected` state
  instead of downgrading the same target to `mentioned`.
- Call `completed` only after the work and required verification succeed. Call
  `rejected` only for intentional cancellation or omission due to scope, safety,
  or a precondition, not for a generic Tool error.
- Every compatible agent chooses the narrowest common target containing the
  request as its outer completion anchor. Before its final response it clears every narrower target
  used by that request, deepest first, then leaves `completed` only on the anchor.
  This must be the final Activity call; the Agent must not answer first or emit a
  later descendant marker. Final-response path mentions do not recreate descendant
  markers. Unrelated scopes are not rolled up.
- Missing a required initial, transition, cleanup, or completion call fails the
  Crispy lifecycle validation even when the Workspace work itself succeeds.
- Keep `mentioned`, `completed`, and `rejected` through the current response.
  `crispy_caa` removes stale state at the next request or scope
  change, when the target is no longer relevant, or after a rename/delete makes
  its marker invalid. Session cleanup is best-effort.
- While an in-Workspace Activity target is waiting to appear in the Graph, the
  Canvas projects one non-persistent ghost node only when its direct parent
  already exists. If intermediate paths are also missing, it keeps the
  notification without inventing the missing hierarchy. Ghosts are deduplicated
  per exact target, capped at 64 per panel, and replaced by the actual node on
  the next Graph snapshot.
- Use `crispy_ping` only for an explicit startup, restart, or connection diagnostic,
  never as a routine preflight.
- Both Activity Tools accept `targetKind` as exactly `file` or `folder`. Their
  `path` is a canonical `/`-separated path relative to the root already assigned
  to the Agent tab. The assigned root itself is `.` and requires
  `targetKind: "folder"`.
- The Tools cannot choose a Workspace root, session, runtime, URI, token, or any
  internal identity. Those values come only from the Host-owned terminal
  assignment and exact runtime lease. Providers must not infer Activity from PTY
  output or filesystem changes. Lifecycle and natural-language mention reporting
  are mandatory Agent instructions; the Host does not infer them by parsing PTY prose.

The shortened `crispy_saa` and `crispy_caa` names keep Claude's fully-qualified
`mcp__<server>__<tool>` identifiers within its 64-character Tool-name limit.

A successful Activity Tool result means only that the MCP child accepted the call
for handoff. It is not evidence that the Host delivered it, that the Webview or
Store applied it, or that the UI displayed it. Likewise, a successful
`postMessage` settlement is not Store delivery proof. A tracked clear receipt is
an internal acknowledgement used only to settle Host occupancy and quota; it is
not a public or provider-visible delivery acknowledgement.

The Canvas notification center projects every current Activity for running sessions
in newest-received order and reuses the same animation recipes as the graph. Selecting
an entry reveals its collapsed, filtered, or paginated target before focusing the
camera. A target that is inside a current Workspace URI but has not reached the Graph
snapshot remains pending and completes the reveal/focus after the next Graph refresh;
only targets outside every current Workspace URI use the unavailable state. Dismissing
an entry clears that exact target/session pair through the same Webview Activity Store,
so its notification, graph binding, and representative effect disappear together
without introducing another Host or MCP protocol path. Each newly received Activity
also creates a compact, animated card to the left of the bell. Cards contain only the
session title and Activity status, stack outward in receive order, expire with an exit
animation after five seconds, and reuse the same graph reveal/focus action when clicked.

Provider credentials keep the existing placeholder boundary. Codex argv contains
only the environment variable name `CRISPY_MCP_TOKEN` through
`bearer_token_env_var`; Claude inline config contains only the literal placeholder
`${CRISPY_MCP_TOKEN}`. The bearer value is added only to the final provider process
environment and is never written as a literal CLI argument or persisted config.

### Qualifying the supported VS Code range

Every change to the minimum or major-version boundary must be qualified. New
stable and Insiders releases inside the existing range are exercised by the
compatibility matrix rather than added to a per-version allowlist.

1. Test the minimum stable Host, the current Stable Host, and a current Insiders
   Host. Keep malformed, too-old, minimum prerelease, and next-major cases as
   fail-closed controls.
2. Re-run strict parser and positive/negative capability tests, Codex and Claude
   gate-specific config and instruction tests, URL/token placeholder checks, and
   the complete `crispy_ping` regression.
3. Exercise the full HTTP → SDK → IPC → runtime → Supervisor → Terminal lease →
   selected-root Graph → Webview Store → receipt/quota chain, including reversed
   promise settlement, same-panel FIFO, multi-root isolation, Trust/root/restart
   cleanup, and a zero-Activity-state unsupported control.
4. Run `pnpm test`, the provider compatibility and authenticated smokes, and the
   matching native VSIX package/inspection/installed smoke. Record the OS, exact
   VS Code and provider versions, root path form, and any unrun environment.
5. Only after those checks pass, change
   `AGENT_ACTIVITY_MINIMUM_VSCODE_VERSION` or the manifest major range. Do not
   widen one without updating and re-running the same matrix for the other.

### Known constraints

- Set validation walks path metadata through several bounded Node filesystem
  operations. That walk is deliberately fail-closed but is not an atomic
  filesystem transaction, so ordinary TOCTOU limits still apply.
- Ordering relies on the pinned same-`WebviewPanel` FIFO order of `postMessage`
  invocations. Promise settlements may arrive in the opposite order and are not
  ordering signals; Crispy does not add a public wire sequence.
- Activity is inactive outside the supported Host range, even when another
  installation mechanism permits the extension to run.
- Tool success, set posting, and `postMessage: true` are not UI or Store delivery
  proof. Tracked receipts settle internal clear quota only.
- Lifecycle cleanup sends a best-effort session clear after revoking the exact
  lease. Cleanup does not claim guaranteed Webview delivery.
- Validation or posting work that never settles is detached under fixed process
  and panel caps. Capacity is not optimistically released; excess work fails
  closed rather than growing without bound.

## Phase 9 verification

Automated coverage includes protocol strictness, atomic Workspace presentation,
multi-root exact lookup and per-tab `cwd`, reset/switch races, stale async ownership,
restart and MCP restart preflights, Trust revoke cleanup, POSIX/Windows path policy,
generic launch, Codex structured/bare launch, notification ordering/focus/dismiss,
and manifest capability checks.

Run the release-oriented checks with the target matching the current host:

```bash
pnpm test
pnpm run package:vsix -- --target <darwin-arm64|linux-x64|win32-x64>
pnpm run smoke:installed-vsix -- --target <same-target>
```

Cross-packaging is intentionally unsupported. The packaged VSIX inspection verifies
the archived extension manifest, production payload allowlist, bundled MCP child,
and target-specific `node-pty` artifacts. The installed smoke additionally launches
a disposable Codex-compatible test process through the real Canvas UI, calls all
three MCP Tools, and inspects the actual Webview binding/effect DOM, continuous CSS
animations, and clear result through a loopback-only CDP connection.

Run the same Host checks against the current release channels when qualifying
compatibility:

```bash
CRISPY_TEST_VSCODE_VERSION=stable pnpm test
CRISPY_TEST_VSCODE_VERSION=insiders pnpm test
pnpm run smoke:installed-vsix -- --target <same-target> --vscode-version stable
pnpm run smoke:installed-vsix -- --target <same-target> --vscode-version insiders
```

### Manual multi-root checklist

Use two disposable local folders with distinguishable names; include spaces and
Unicode in at least one path. On Windows, also repeat with a drive-rooted path (and
optionally a UNC path); on macOS/Linux use an absolute POSIX path.

1. Open both folders in one trusted multi-root Workspace and run `Crispy: Open Canvas`.
2. Create two Agent tabs, select a different Workspace in each, start a provider,
   confirm the custom Workspace list stays inside the Agent card, and verify the
   bottom session bar changes to each root name when switching tabs. Then ask each
   provider to report the host process working directory without modifying files.
3. Change only one tab's provider and confirm its Workspace stays selected. Confirm
   that choosing another Workspace is blocked until Reset completes.
4. Reset that tab, select the other root, and confirm the new process uses that root.
5. Remove a root while its CLI is running. Existing I/O should continue; restart or
   MCP restart should fail with the root-unavailable state and must not fall back.
6. Re-add the root, then revoke Workspace Trust while both an Agent and MCP session
   are active. Input/output should stop, the process trees should terminate, and the
   assignment should remain retryable. Re-trust and retry the same assignment.

Manual provider smoke requires locally installed, authenticated CLIs. Record the OS,
VS Code version, provider version, root path form, and observed result; do not treat
an unrun platform or provider as passing.
