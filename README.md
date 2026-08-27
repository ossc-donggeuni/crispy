# Crispy

<p align="center">
  <img src="resources/crispy-marketplace-trans.png" alt="Crispy logo" width="144">
</p>

Crispy is a Visual Studio Code extension for exploring a workspace as a project
graph and running Codex or Claude Code in workspace-scoped terminals.

It brings project structure, AI Agent sessions, visual tasks, and live Agent
activity into one Canvas.

## Key features

<img width="3248" height="1990" alt="image" src="https://github.com/user-attachments/assets/0d17eeba-a079-4bdf-8fc6-3ca1fad67380" />

- **Project Graph** — Browse projects, folders, and files in single-root or
  multi-root workspaces.
- **Agent Workspace** — Run Codex and Claude Code in independent terminal tabs,
  each assigned to one workspace root.
- **Visual Tasks** — Build Start → Work → End workflows, assign project areas, and
  run each Work step with Codex or Claude.
- **Agent Activity** — See planned, active, editing, completed, mentioned, and
  rejected activity on the relevant files and folders.
- **Workspace Tools** — Preview files, view Git changes, rename items, and move
  files or folders to Trash from the Canvas.

## Requirements

- Visual Studio Code `1.125.0` or newer within the `1.x` release line.
- A trusted local folder or multi-root workspace.
- A supported platform:
  - macOS Apple silicon (`darwin-arm64`)
  - Linux x64 (`linux-x64`)
  - Windows x64 (`win32-x64`)
- Codex CLI, Claude Code, or both, installed and authenticated separately when
  using Agent terminals.

Crispy does not install provider CLIs or sign in to provider accounts.

## Quick start

1. Open a trusted local workspace in VS Code.
2. Select the Crispy icon in the Activity Bar.
3. Select **Open Canvas**.
4. Open the Agent panel and select a workspace root.
5. Choose **Codex** or **Claude** and use the terminal normally.

You can also run **Crispy: Open Canvas** from the Command Palette.

Each Agent tab belongs to one workspace root. To use another root, reset the tab
and select the new workspace.

## Using the Canvas

### Project Graph

- Click folders to expand or collapse them.
- Double-click a file to open it in the VS Code editor.
- Right-click a file or folder to inspect its details.
- Drag nodes to arrange the graph.
- Detach a file or folder when you want to work with it as a separate graph root.
- Use the minimap and root list to navigate large workspaces.

### Visual Tasks

Create a task from the Canvas navigator, add Work nodes, and connect them between
Start and End. Each Work node can use Codex or Claude and can have its own prompt,
reference scope, and editable scope.

When the task starts, Crispy runs dependency-ready Work nodes in Agent tabs and
shows their progress on the task graph.

### Agent Activity

Compatible Agent sessions report their current workspace activity through
Crispy's local MCP integration. Activity appears on the project graph, minimap,
and notification center. Selecting a notification focuses the related file or
folder and can take you to the responsible Agent tab.

## Settings

| Setting | Description |
| --- | --- |
| `crispy.codexCliPath` | Optional full path to the Codex executable. |
| `crispy.claudeCliPath` | Optional full path to the Claude Code executable. |

Leave a setting empty to use Crispy's platform-specific executable discovery.
Reset the affected Agent tab after changing a CLI path.

## Workspace data and security

Crispy stores graph and task state under `.crispy/` in each workspace root. Add
`.crispy/` to your repository's ignore rules when that state should remain local.

Agent processes can start only in trusted, local workspaces. Crispy validates the
workspace root and launch configuration in the Extension Host, uses a loopback-only
MCP connection, and does not store Codex or Claude account credentials.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Development

The project requires Node.js `24.x` and pnpm `11.18.0`.

```bash
pnpm install --frozen-lockfile
pnpm test
```

Build a VSIX on the matching target platform with:

```bash
pnpm run package:vsix -- --target <darwin-arm64|linux-x64|win32-x64>
```

## Support

- [Support guide](SUPPORT.md)
- [GitHub Issues](https://github.com/ossc-donggeuni/crispy/issues)
- [Changelog](CHANGELOG.md)
- [MIT License](LICENSE.md)
