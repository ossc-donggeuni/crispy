# Changelog

All notable changes to Crispy are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.0.1 - 2026-08-27

Initial release of Crispy for Visual Studio Code.

### Project visualization

- Added an interactive, multi-root project graph for navigating projects, folders,
  and files in a VS Code workspace.
- Added deterministic tree layout, free node positioning, pan and zoom controls,
  animated camera focus, and persistent graph state.
- Added a navigator with a minimap, draggable viewport indicator, root list, and
  zoom controls for moving through large workspaces.
- Added collapsible folders, local file-type icons, and paginated file groups that
  keep dense directories readable.
- Added folder and file detachment as independent graph roots, with backlinks and
  drag-to-reattach support for returning them to their original location.
- Added graph actions that reveal and open the selected workspace file in the
  active VS Code editor.

### Visual task workflows

- Added visual task blueprints composed of Start, Work, and End nodes connected as
  a directed acyclic graph.
- Added editable task and work titles, descriptions, prompts, provider selection,
  and per-node reference and work scopes.
- Added dependency-aware execution that starts ready Work nodes with Codex or
  Claude and advances the task as each required step completes.
- Added read-only and read-write workspace scope enforcement for task agents, with
  explicit approval when an agent requests additional scope.
- Added live running, waiting, completed, rejected, failed, and blocked states on
  task nodes and edges.
- Added validated JSON import and clipboard export for sharing or restoring task
  blueprints.

### Agent workspace

- Added tabbed, workspace-scoped terminals powered by xterm.js and node-pty for
  running Codex and Claude Code inside the Canvas.
- Added independent provider and workspace-root assignments for every Agent tab,
  with clear start, restart, reset, and close lifecycles.
- Added provider executable discovery on macOS, Linux, and Windows, plus
  `crispy.codexCliPath` and `crispy.claudeCliPath` settings for explicit CLI paths.
- Added session naming, pinning, per-session colors, horizontal tab navigation,
  and accessible tab context menus.
- Added a dockable, resizable, and collapsible Agent panel that preserves the full
  graph canvas beneath it.
- Added VS Code terminal-theme integration, including ANSI and true-color output.
- Added MCP status indicators and a confirmation-based recovery action for
  retryable Codex or Claude connection failures.

### Agent Activity

- Added the `crispy_ping` MCP compatibility tool and the `crispy_saa` and
  `crispy_caa` Agent Activity tools for supported VS Code hosts.
- Added six workspace activity states: planned, active, editing, completed,
  mentioned, and rejected.
- Added session-colored graph bindings, animated node effects, minimap highlights,
  transient activity cards, and a newest-first notification center.
- Added notification actions that reveal hidden or paginated targets, focus the
  graph camera, select the exact Agent tab, or dismiss the activity.
- Added exact workspace-root and session validation before activity is delivered
  to the Canvas.

### Workspace safety and persistence

- Added trusted, local `file:` workspace enforcement for Agent and task process
  launches; remote, virtual, unavailable, and untrusted roots fail closed.
- Added host-owned validation for workspace roots, executable paths, process
  arguments, environments, MCP routes, and activity targets.
- Added Workspace Trust revocation handling that blocks further terminal I/O and
  terminates associated Agent and MCP process trees.
- Added session-only MCP credentials: bearer values are injected only into the
  final provider process environment and are not stored in CLI arguments or
  persisted configuration.
- Added workspace-aware restoration of graph and task state through per-root
  `.crispy/state.json` metadata, with panel layout restored through VS Code's
  Webview session state.
- Added stale-state and multi-root transition handling so removed, re-added, or
  relocated roots do not silently take ownership of another root's tasks.

### VS Code and distribution

- Added the Crispy Activity Bar container and Overview view. **Open Canvas** opens
  the Canvas and closes the temporary Overview Sidebar; the command palette also
  provides **Crispy: Open Canvas** without changing the current Sidebar.
- Added Marketplace and Activity Bar branding, Free pricing metadata, public
  repository links, and GitHub Issues as the support channel.
- Added platform-specific VSIX packages for macOS Apple silicon (`darwin-arm64`),
  Linux x64 (`linux-x64`), and Windows x64 (`win32-x64`).
- Added strict VSIX payload, manifest, branding, MCP bundle, native binary, and
  installed-extension smoke validation.
- Declared Visual Studio Code `1.125.0` as the minimum supported version.
