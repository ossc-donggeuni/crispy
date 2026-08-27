# Crispy Support

Thank you for using Crispy. Clear reports make it much easier to reproduce a
problem, understand its impact, and work toward a useful solution.

## Official support channel

Use [GitHub Issues](https://github.com/ossc-donggeuni/crispy/issues) for bug
reports, feature requests, setup questions, and documentation improvements.

Before opening a new issue:

1. Search the [existing issues](https://github.com/ossc-donggeuni/crispy/issues)
   for the same behavior or request.
2. Confirm the issue still occurs on the latest available Crispy release.
3. Reduce the problem to the smallest workspace and shortest sequence of actions
   that still reproduces it.
4. Remove credentials, private source code, personal data, and confidential paths
   from every screenshot, log, task prompt, and attachment.

Support is provided on a best-effort basis. There is no guaranteed response time,
but well-scoped reports with complete reproduction details can be investigated
more effectively.

## Supported environment

Crispy currently supports:

- Visual Studio Code `1.125.0` or newer within the `1.x` release line.
- macOS on Apple silicon (`darwin-arm64`).
- Linux on x64 (`linux-x64`).
- Windows on x64 (`win32-x64`).
- Trusted, local workspaces that use the `file:` URI scheme for Agent and task
  execution.
- Codex CLI and Claude Code when they are installed and authenticated separately.

Remote, virtual, unavailable, or untrusted workspace roots cannot start Crispy
Agent processes. Crispy does not install provider CLIs, sign in to provider
accounts, or manage provider credentials.

## What to include in a bug report

Please include:

- A short title that describes the visible failure.
- The expected behavior and the actual behavior.
- Exact steps to reproduce the issue from a fresh VS Code window when possible.
- The Crispy version and installation method, including the VSIX filename if one
  was installed manually.
- The full VS Code version from **Help: About** or `code --version`.
- Your operating system, version, CPU architecture, and whether the workspace is
  single-root or multi-root.
- Whether Workspace Trust is enabled and whether the workspace is local, remote,
  or virtual.
- The selected provider and its version from `codex --version` or
  `claude --version`, when the problem involves an Agent.
- The smallest relevant log excerpt or screenshot, after redaction.
- Whether the issue is consistently reproducible or intermittent.

If a minimal repository is required, create a new repository containing only the
files necessary to reproduce the problem. Do not publish proprietary code merely
to make a support case.

## Collecting diagnostic information

Use only the sources relevant to the problem:

- For extension activation or host-side failures, run **Developer: Show Logs...**
  from the Command Palette and inspect the **Extension Host** log.
- For Canvas rendering or interaction failures, run **Developer: Open Webview
  Developer Tools** and collect the smallest relevant console error and stack.
- For provider startup or terminal failures, include the visible Crispy terminal
  output and the result of the provider's `--version` command.
- For MCP failures, include the status shown in the Agent panel and whether the
  retry action succeeds. Note that retrying ends and recreates the current tab's
  provider session.

Please paste logs as text when practical. Put longer excerpts in a fenced code
block so paths and stack traces remain readable.

## Common setup checks

### The Canvas does not open

Open the Crispy icon in the Activity Bar and select **Open Canvas**, or run
**Crispy: Open Canvas** from the Command Palette. If activation fails, check the
Extension Host log and confirm that the installed VSIX matches the current
platform and architecture.

### Codex or Claude cannot be started

Verify that the selected CLI runs successfully in a normal terminal:

```text
codex --version
claude --version
```

Install and authenticate the provider separately if needed. If VS Code cannot
discover the executable, set the full path in `crispy.codexCliPath` or
`crispy.claudeCliPath`, then reset the affected Crispy tab before trying again.

### A workspace cannot be selected or used

Confirm that the folder is part of the current VS Code workspace, is available on
the local filesystem, and is trusted. Each Agent tab is assigned to exactly one
workspace root. Changing that root requires a tab reset.

### MCP shows a retryable failure

Use the recovery action only after reading its confirmation message: it stops the
current tab's provider process and starts a fresh Agent and MCP session. Other tabs
are not restarted. Claude Code versions older than `2.1.121` run without Crispy's
Claude MCP integration and should be updated when MCP features are required.

### Agent Activity is missing

Confirm that the extension is running on a supported VS Code version and that the
current provider session has an active Crispy MCP connection. Activity is scoped
to the exact trusted workspace root assigned to the tab; targets outside that root
are rejected.

## Feature requests

A constructive feature request should explain:

- The workflow or problem you are trying to improve.
- Who benefits and how often the situation occurs.
- The desired outcome, without requiring a specific implementation.
- Any alternatives or workarounds you have already tried.
- Compatibility, security, or workspace constraints that may affect the design.

Screenshots, sketches, and small examples are welcome when they clarify the
workflow and contain no sensitive information.

## Security reports

Do not disclose vulnerability details, credentials, access tokens, exploit code,
or private workspace content in a public issue.

Check the repository's [Security](https://github.com/ossc-donggeuni/crispy/security)
page for a private vulnerability reporting option. If no private option is
available, open a minimal public issue asking for a private contact route without
including the vulnerability details.

## Privacy and redaction

Never attach provider tokens, API keys, cookies, authorization headers, private
keys, or account credentials. Review `.crispy/state.json` before sharing it: task
titles, prompts, workspace paths, and graph state may reveal private project
information. Redact user names and local filesystem paths unless they are essential
to reproduce a path-handling problem; when they are essential, replace unrelated
segments with neutral placeholders.

## Contributing a fix

Fixes and documentation improvements are welcome through the public repository.
Before preparing a change, open or reference an issue that explains the problem
and intended behavior. Keep the change focused, add or update tests where behavior
changes, and run:

```text
pnpm install --frozen-lockfile
pnpm test
```

Platform-specific packaging and installed-extension smoke checks may also be
requested for changes that affect terminals, MCP, native binaries, or the VSIX
payload.
