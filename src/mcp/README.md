# Codex MCP 실행 방법

## 사전 준비

```bash
cd /Users/idonghyeon/crispy
pnpm install
codex --version
```

Codex CLI는 미리 로그인되어 있어야 한다. Crispy Terminal은 신뢰된 로컬 단일-root workspace에서만 실행된다.

## Extension Development Host에서 실행

1. VS Code에서 `/Users/idonghyeon/crispy`를 연다.
2. `F5`를 누르고 `Run Extension`을 실행한다.
3. 새 Extension Development Host 창에서 테스트할 로컬 단일 폴더를 열고 Workspace Trust를 승인한다.
4. Command Palette에서 `Crispy: Open Canvas`를 실행한다.
5. Agent 영역에서 `Codex`를 선택한다.

MCP 연결을 확인하려면 열린 Codex에 다음 프롬프트를 입력한다.

```text
Call the crispy_ping MCP tool once. Do not run shell commands and do not modify files.
```

정상 연결 시 `crispy_ping`이 다음 형태의 결과를 반환한다.

```json
{"ok":true,"server":"crispy","mode":"observation-only"}
```

C5 상태 UI는 아직 없으므로 별도의 MCP 연결 배지나 상태 문구는 표시되지 않는다.

## VSIX로 실행

macOS Apple Silicon용 VSIX를 빌드하고 설치한다.

```bash
cd /Users/idonghyeon/crispy
pnpm run package:vsix -- --target darwin-arm64
code --install-extension /Users/idonghyeon/crispy/artifacts/vsix/crispy-0.0.1-darwin-arm64.vsix --force
```

설치 후 VS Code에서 `Developer: Reload Window`를 실행한 다음, 신뢰된 로컬 단일 폴더에서 `Crispy: Open Canvas`를 열고 `Codex`를 선택한다.

## 자동 smoke 실행

```bash
cd /Users/idonghyeon/crispy
pnpm run prepare:codex-mcp-smoke
pnpm run smoke:codex-mcp
```

정상 실행 결과는 다음과 같다.

```text
adapter_ready
awaiting_activity
activity_observed
```
