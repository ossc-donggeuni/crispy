# MCP 실행 방법과 provider 검증 기록

## 사전 준비

```bash
cd /Users/idonghyeon/crispy
pnpm install
codex --version
```

Codex CLI는 미리 로그인되어 있어야 한다. Crispy Terminal은 신뢰된 로컬 단일-root workspace에서만 실행된다.
실행 시 `codex --version`을 확인해 `0.149.0` 미만에는
`shell_environment_policy.exclude=["CRISPY_MCP_TOKEN"]`을, `0.149.0` 이상에는
`shell_environment_policy.filters.CRISPY_MCP_TOKEN="exclude"`를 사용한다. 버전 또는 config
문법을 안전하게 판정할 수 없으면 credential 없는 bare Codex로 fail-open한다.

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

## 상태 UI의 의미

- indicator 없음: MCP를 준비 중이거나 authenticated activity를 아직 관찰하지 않은 상태다.
  요청 silence는 실패가 아니며 handshake timeout이나 추측성 connection-lost 상태를 만들지 않는다.
- 각 탭 상단의 초록 점: 올바른 bearer token과 exact route를 사용한 protocol-valid ID-bearing
  요청이 SDK의 정상 JSON-RPC result를 만든 상태다. 화면에는 별도 연결 문구를 표시하지 않는다.
- 빨강: current tab/session에서 명시적인 MCP failure가 발생한 상태다. UI에는 raw reason,
  stderr, executable, args, port, route, token 또는 config가 아닌 reason별 고정 문구만 나온다.

retryable 빨간 상태에만 `MCP와 Agent 다시 시작` 버튼이 보인다. 확인 문구는 이 탭의 현재
Codex 또는 Claude와 CLI 대화가 종료됨을 명시한다. 수락하면 old CLI process tree와 MCP child를 먼저
정리하고 old token을 revoke한 뒤 fresh sessionId/child/random port/route/token/generation/
config/PTY로 같은 provider를 자동 실행한다. 다른 탭의 PTY와 MCP runtime은 영향을 받지 않는다.

Codex 또는 Claude PTY가 실행된 뒤 MCP child가 비정상 종료되면 현재 provider 입출력은 유지되고
`adapter_exited` 빨간 상태만 표시된다. 사용자 확인 전에는 bare relaunch나 adapter 자동
재생성을 하지 않는다. 반대로 startup MCP 실패는 기존 정책대로 credential 없는 bare
provider를 한 번 실행하므로 CLI 자체는 계속 사용할 수 있다.

## 보안 및 지원 경계

- session마다 최소 256-bit CSPRNG bearer token, opaque route, random loopback port와 generation을
  따로 만들며 파일, settings, Webview state, argv, log와 telemetry에 영속화하지 않는다.
- MCP server는 `127.0.0.1`의 exact random route에서만 요청을 받고 `crispy_ping`만 등록한다.
- 배포 보장 target은 macOS Apple Silicon `darwin-arm64`, Linux glibc `linux-x64`, Windows native
  `win32-x64`다. 지원 밖 환경에서는 MCP만 비활성화하고 bare CLI를 막지 않는다.
- Windows `.cmd`만 `ComSpec` one-shot wrapper를 사용하며 macOS/Linux native executable과
  Windows `.exe`는 PTY root process로 직접 실행한다.

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

설치된 Codex의 config parsing과 node-pty 실행 경계만 확인하려면 다음을 실행한다.

```bash
pnpm run smoke:codex-config-compat
```

정상 출력 예시는 다음과 같다.

```text
[codex-config-compat-smoke] keyed-filters config parsed through node-pty.
```

Windows에서는 설치된 실제 `codex.cmd`의 config parsing과, 특수문자 경로에 둔
독립 fixture의 `cmd.exe` one-shot 인자 보존을 분리해 검증한다.

```text
[codex-config-compat-smoke] keyed-filters config parsed through node-pty.
[codex-config-compat-smoke] Windows cmd-one-shot special-path launch passed.
```

version probe가 실패하면 `spawn_error`, `exit_nonzero`, `timeout`,
`unparsable_version`처럼 credential을 포함하지 않는 원인이 출력된다.

production/VSIX와 process cleanup까지 포함한 release 확인은 다음 순서로 실행한다.

```bash
pnpm run check-types
pnpm run lint
pnpm run test
pnpm run package
pnpm run package:vsix -- --target darwin-arm64
pnpm run inspect:vsix
pnpm run smoke:pty-kill
pnpm run smoke:codex-config-compat
pnpm run prepare:codex-mcp-smoke
pnpm run smoke:codex-mcp
pnpm run smoke:installed-vsix -- --target darwin-arm64
```

실제 Codex smoke는 로그인된 provider와 loopback/PTY 실행 권한이 필요하므로 일반 CI unit gate와
구분한다. C5 gate가 완료된 뒤에만 Claude L0을 시작한다. Antigravity MCP 연결과
`provider_update_required`의 실제 emit/update 정책은 별도 제품 결정이며 이 단계에서는
구현하지 않는다.

## Claude Phase L0 공식 계약 검증 — 2026-08-22

### 검증 환경과 결론

- 이 브랜치의 기준은 Codex C5 완료 commit `8b86ff9`다.
- 현재 macOS Apple Silicon에 설치된 Claude Code는 `2.1.234 (Claude Code)`이며
  `claude --help`에서 `--mcp-config <configs...>`와 `--strict-mcp-config`를 확인했다.
- 공식 CLI reference는 `--mcp-config`가 JSON file 또는 JSON string을 현재 실행에 load한다고
  명시한다. Crispy는 file을 만들지 않고 inline JSON string 하나만 argv에 전달한다.
- 공식 MCP 문서의 remote HTTP shape는 `type: "http"`, `url`, `headers`이고 `headers` 안의
  `${VAR}` expansion을 지원한다. 따라서 token 값은 JSON/argv에 넣지 않고 literal
  `${CRISPY_MCP_TOKEN}`만 넣을 수 있다.
- `alwaysLoad: true`는 모든 server type에서 지원되며 해당 server의 tool을 startup에 load한다.
  이 대기는 연결 실패의 독자적인 Crispy timeout 근거가 아니고, authenticated activity가
  늦어져도 `awaiting_activity`를 유지한다.
- `--strict-mcp-config`는 inline config 외의 MCP config를 무시하므로 사용하지 않는다. 이 flag가
  없으면 기존 user/project MCP source를 보존하면서 inline server를 추가할 수 있다. 이름 충돌은
  session별 random server name으로 피한다.

L1 serializer가 만들어야 하는 token-free argument의 의미는 다음과 같다. 아래 값은 설명용이며
실제 URL과 server name은 session마다 새로 만든다.

```json
{
  "mcpServers": {
    "crispy_canvas_<random>": {
      "type": "http",
      "url": "http://127.0.0.1:<random-port>/mcp/<random-route>",
      "headers": {
        "Authorization": "Bearer ${CRISPY_MCP_TOKEN}"
      },
      "alwaysLoad": true
    }
  }
}
```

`CRISPY_MCP_TOKEN`은 최종 PTY spawn boundary에서만 provider environment에 overlay한다. 공식
문서상 required 변수가 없고 default도 없으면 config parsing이 실패한다. L1의 negative control은
같은 inline config에서 token environment만 제거했을 때 Claude의 자연 종료까지 authenticated activity가
관찰되지 않는지 확인한다. exit code는 config rejection 원인을 증명하지 않으므로 성공 조건으로 삼지
않고, signal 종료는 관찰이 중단된 것으로 보고 `negative_control_inconclusive`로 실패한다. 성공 상태
`negative_control_no_authenticated_activity`는 credential-isolation 관찰 결과일 뿐 config 오류 문구나
Crispy server의 `401` 응답을 뜻하지 않는다. missing/wrong bearer token의 정확한 `401` 계약은 별도
protocol integration test가 검증한다.

### user MCP와 권한 보존 계약

- `--strict-mcp-config`, `--tools`, `--disallowedTools`와 global permission deny를 주입하지 않는다.
  특히 `--tools`는 MCP tool 제한 수단이 아니며, broad `mcp__*` deny는 사용자의 다른 MCP까지
  막을 수 있다.
- `MCP_DISCOVERY_CACHE`, `ENABLE_TOOL_SEARCH`, `MCP_CONNECTION_NONBLOCKING` 등 user의 다른 MCP
  동작을 바꾸는 environment override를 주입하지 않는다.
- Crispy Claude server의 최종 tool allowlist는 공통 server가 등록한 `crispy_ping` 하나뿐이다.
  `alwaysLoad`는 이 작은 server에만 inline으로 적용한다.
- managed `allowedMcpServers`/`deniedMcpServers`는 `--mcp-config` server에도 적용되며 Crispy가
  우회하지 않는다.

### startup diagnostic의 좁은 근거

- workstation에 system `managed-mcp.json`이 있고 dynamic `--mcp-config`를 전달하면 공식 문서는
  startup exit와 정확한 문구 `You cannot dynamically configure MCP servers when an enterprise MCP
  config is present`를 명시한다. L1 smoke에서는 redacted stderr를, direct PTY인 L2에서는 bounded
  in-memory startup output을 사용하며 non-zero exit와 interactive prompt 미도달까지 모두 일치할
  때만 `provider_policy_blocked` 후보로 사용한다.
- allowlist/denylist에 의해 Crispy server만 filter된 경우, 401/일반 network failure, login/auth
  failure, 정상 사용자 종료, `alwaysLoad`의 최대 5초 대기는 startup config rejection이 아니다.
  자동 bare relaunch 근거로 사용하지 않는다.
- `provider_config_rejected`에 쓸 만큼 좁은 interactive startup signature는 L0 공식 문서만으로
  확정하지 않았다. L1에서 token 없는 intentionally-invalid fixture로 exit/stderr를 수집해
  deterministic하고 credential-free인 경우에만 pattern을 추가한다. 그 전에는 분류하거나 bare
  relaunch하지 않는다.
- `provider_update_required`의 최소 버전과 emit 정책은 정하지 않는다.

### 공통 경계 재사용과 최소 구현 surface

다음 C5 경계는 Claude에서도 그대로 재사용한다.

- `McpAdapterSupervisor` / `McpSessionRuntime`: session별 child, port, route, token, generation과
  stale cleanup 소유권
- `AgentLaunchPlan`, `createAgentProcessSpawnRequest`, `spawnAgentPty`: credential을 최종 environment에
  합성하고 direct 또는 Windows `cmd-one-shot` PTY root process로 실행하는 경계
- `resolveAgentExecutable`: Claude의 `claude`, `claude.cmd`, `claude.exe`와 설정된 executable path
- 공통 MCP protocol server, `crispy_ping`, authenticated activity 판정과 failure domain

L1에서 추가할 최소 provider surface는 `src/mcp/**`의 Claude inline-config serializer,
bare/authenticated launch-plan builder, 좁은 diagnostic matcher와 실제 smoke runner다. 새 unit test와
fixture는 `src/test/**`에만 둔다. L2에서 Terminal Host의 Codex 전용 orchestration 이름과 generation
map을 provider-neutral session orchestration으로 좁게 일반화하고 Extension wiring에 Claude
preparation을 추가한다. L3 전에는 Claude status/retry UI를 연결하지 않는다.

### L1 실제 smoke 계획

1. 공통 supervisor가 준비한 current random URL/token으로 token-free inline JSON을 만든다.
2. `claude`를 node-pty의 direct root process로 실행하고 token은 environment에만 넣는다.
3. `crispy_ping` 한 번을 요청해 config 인식, HTTP header expansion, tool list/call과
   `activity_observed`를 확인한다.
4. argv/diagnostic/snapshot 전체에 token 값이 없고 inline JSON에는 literal placeholder만 있는지
   검사한다.
5. 같은 config에서 token env만 제거한 negative control이 자연 종료까지 authenticated activity를
   만들지 않는지 확인한다. exit code에는 config rejection 의미를 부여하지 않고 signal 종료는
   inconclusive로 실패시키며, provider output이나 Crispy server의 `401` 응답은 검증하지 않는다.
6. `--strict-mcp-config`와 global tool/cache override가 없는지, 기존 user MCP source를 배제하지
   않는지 argv 단위 테스트와 실제 `/mcp` 관찰로 확인한다.
7. 정책/config rejection fixture의 exit, stderr, interactive prompt 도달 여부를 별도로 수집하되
   login/network/정상 종료와 겹치는 pattern은 채택하지 않는다.

공식 근거:

- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage)
- [Claude Code managed MCP](https://code.claude.com/docs/en/managed-mcp)

## Claude Phase L2 자동 lifecycle — 2026-08-22

Extension Host는 Claude 선택 시 workspace와 executable을 먼저 확정하고 credential-free
`claude --version` probe를 bounded child process로 실행한다. `>=2.1.121`일 때만 공통
`McpAdapterSupervisor`에서 session child/port/route/token을 만들고 `auth.registered` 이후 inline
config plan과 최종 provider environment를 생성한다. probe 실패·timeout·unparsable 또는 minimum
미만은 adapter와 token을 만들지 않고 bare Claude로 fail-open하며 `provider_update_required`를
emit하지 않는다.

TerminalHost의 기존 Codex generation map과 direct-spawn transaction은 provider-neutral ownership으로
일반화했다. Codex와 Claude 모두 current tab/session/provider/generation이 모든 await 뒤 일치해야 PTY를
spawn하고, `CRISPY_MCP_TOKEN`은 authenticated plan의 final environment에만 들어간다. stale base token의
대소문자 변형과 `ELECTRON_RUN_AS_NODE`는 bare/authenticated 경로 모두에서 제거된다.

Authenticated Claude spawn 실패는 token/child cleanup 후 bare spawn 한 번만 허용한다. 두 spawn이
모두 실패하면 `start_failed`이며 세 번째 spawn은 없다. PTY 전에 adapter가 죽으면 bare로 전환하고,
PTY 뒤 adapter가 죽으면 Claude PTY와 input/output/resize는 유지하면서 credential/runtime만 정리한다.
정상 Claude exit, tab close, reset, provider 변경, Panel dispose와 deactivate는 공통 cleanup을 사용한다.

제품 PTY는 stdout/stderr가 합쳐지므로 startup fallback classifier는 최대 16 KiB의 in-memory PTY
startup output만 보며 어디에도 기록하지 않는다. non-zero exit, signal 없음, interactive input 및
authenticated activity 미관찰과 exact managed-policy/current-server schema diagnostic이 함께 맞을 때만
fresh bare session을 한 번 만든다. login/auth, network, 정상 종료, 사용자가 입력한 뒤의 종료와 MCP
silence는 자동 fallback으로 분류하지 않는다.

## Claude Phase L3 공통 상태와 재시작 — 2026-08-22

Claude도 Codex와 같은 Host/Webview 상태 계약을 사용한다. 인증된 protocol-valid result를 처음
관찰한 뒤에만 초록 indicator를 표시하고, 명시적인 MCP failure만 빨강으로 표시한다. compatibility
minimum 미만이나 version probe 실패·timeout·unparsable은 계속 indicator 없이 bare Claude로
fail-open하며 `provider_update_required` 또는 업데이트 안내를 내보내지 않는다.

PTY 시작 뒤 adapter가 종료되면 Claude PTY와 input/output/resize를 유지하고 retryable
`adapter_exited`만 표시한다. 사용자가 확인한 retry는 current Claude 탭의 old process tree와 child를
정리한 뒤 fresh sessionId, child, port, route, token, generation, inline config와 PTY를 만든다. Host와
Webview 양쪽이 중복 요청을 막고, Codex/Claude 동시 탭의 status와 restart transaction은 서로 영향을
주지 않는다. 검증된 managed-policy 또는 current-server schema 거부로 bare Claude를 한 번 재실행한
경우에는 새 bare session에 non-retryable 고정 실패 문구를 표시한다.
