# Crispy

Crispy is a VS Code extension for visualizing a project and running Codex, Claude,
or Antigravity in tab-scoped terminals. In a multi-root Workspace, every Agent tab
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
`src/agent/README.md` and `src/mcp/README.md`.

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

## Phase 9 verification

Automated coverage includes protocol strictness, atomic Workspace presentation,
multi-root exact lookup and per-tab `cwd`, reset/switch races, stale async ownership,
restart and MCP restart preflights, Trust revoke cleanup, POSIX/Windows path policy,
generic launch, Codex structured/bare launch, and manifest capability checks.

Run the release-oriented checks with the target matching the current host:

```bash
pnpm test
pnpm run package:vsix -- --target <darwin-arm64|linux-x64|win32-x64>
pnpm run smoke:installed-vsix -- --target <same-target>
```

Cross-packaging is intentionally unsupported. The packaged VSIX inspection verifies
the archived extension manifest, production payload allowlist, bundled MCP child,
and target-specific `node-pty` artifacts.

### Manual multi-root checklist

Use two disposable local folders with distinguishable names; include spaces and
Unicode in at least one path. On Windows, also repeat with a drive-rooted path (and
optionally a UNC path); on macOS/Linux use an absolute POSIX path.

1. Open both folders in one trusted multi-root Workspace and run `Crispy: Open Canvas`.
2. Create two Agent tabs, select a different Workspace in each, start a provider,
   and ask it to report the host process working directory without modifying files.
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
