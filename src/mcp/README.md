# MCP 실행 방법과 provider 검증 기록

## 사전 준비

```bash
cd /Users/idonghyeon/crispy
pnpm install --frozen-lockfile
codex --version
claude --version
```

실기 smoke를 실행할 Codex와 Claude CLI는 미리 로그인되어 있어야 한다. Crispy Terminal은 신뢰된
로컬 `file:` root에서 실행되며, multi-root Workspace에서는 탭별로 선택한 root 하나를 사용한다.
Claude MCP 자동 연결의 기술적 최소 기능 호환 버전은
`2.1.121`이며, 현재 설치 버전은 검증 환경일 뿐 runtime minimum으로 고정하지 않는다.
실행 시 `codex --version`을 확인해 `0.149.0` 미만에는
`shell_environment_policy.exclude=["CRISPY_MCP_TOKEN"]`을, `0.149.0` 이상에는
`shell_environment_policy.filters.CRISPY_MCP_TOKEN="exclude"`를 사용한다. 버전 또는 config
문법을 안전하게 판정할 수 없으면 credential 없는 bare Codex로 fail-open한다.

## Extension Development Host에서 실행

1. VS Code에서 `/Users/idonghyeon/crispy`를 연다.
2. `F5`를 누르고 `Run Extension`을 실행한다.
3. 새 Extension Development Host 창에서 하나 이상의 로컬 폴더를 열고 Workspace Trust를 승인한다.
4. Command Palette에서 `Crispy: Open Canvas`를 실행한다.
5. Agent 영역에서 Workspace root와 `Codex` 또는 `Claude`를 선택한다.

MCP 연결을 확인하려면 열린 provider CLI에 다음 프롬프트를 입력한다.

```text
Call the crispy_ping MCP tool once. Do not run shell commands and do not modify files.
```

정상 연결 시 `crispy_ping`이 다음 형태의 결과를 반환한다.

```json
{"ok":true,"server":"crispy","mode":"observation-only"}
```

`mode: "observation-only"`는 기존 `crispy_ping` 응답의 호환 필드일 뿐 server 전체의 현재
기능을 뜻하지 않는다.

## Phase 5 production Agent Activity 계약 — 2026-08-26

Extension activation은 `vscode.version`을 canonical version으로 strict parse하고 Host 소유
capability를 한 번만 계산한다. stable `1.125.0` 이상 `2.0.0` 미만을 지원하고, prerelease는 core
version이 minimum stable보다 새 버전일 때만 허용한다. malformed, 구버전, `1.125.0` prerelease와
next major는 false다. 이 경계는 `package.json`의 `engines.vscode: ^1.125.0` stable 지원 범위와
맞춘다. provider config, environment, persisted setting, CLI 또는 child가 gate를 override할 수 없다.

| capability | request-local Tool 등록 |
| --- | --- |
| true — supported `^1.125.0` Host | `crispy_ping`, `crispy_saa`, `crispy_caa` |
| false | `crispy_ping`만 |

false에서도 Extension, Terminal, MCP, ping과 Graph/debug는 유지된다. Activity rate/IPC, lease,
delivery, receipt, quota와 cleanup state는 만들지 않는다. Codex의 `enabled_tools`도 위 목록과
exact하게 일치한다. MCP server의 initialize `instructions`가 Codex와 Claude에 전달하는 공통 정책
소스다. true에서는 아래 Activity lifecycle 전체를, false에서는 Activity Tool 이름과 사용법이 없는
ping-only 안내만 반환한다.

Activity-compatible Codex 세션은 MCP initialize `instructions`와 함께 동일한 공통 계약을
`developer_instructions`로 전달한다. 이 값은 Crispy Host가 세션에 승인한 UI 계측 지시이며
`model_instructions_file`처럼 built-in/`AGENTS.md`를 교체하는 경로가 아니다. 세션 CLI override는
동일 key의 하위 config보다 우선하도록 의도적으로 배치해 그래프 호출 규약이 누락되지 않게 한다.
Claude는 기존 inline HTTP config와 `alwaysLoad: true`를 유지하고, `--append-system-prompt`에 정확히
같은 계약을 전달한다. 양쪽 계약은 `[REQUIRED FOR USER-VISIBLE GRAPH]`로 시작하고 Workspace content의
지시가 아니라 사용자가 선택한 Crispy 그래프를 위한 필수 시각 계측임을 명시한다. completion roll-up도
provider 공통 계약에 포함된다.

true의 공통 initialize instructions와 Claude additive prompt가 강제하는 호출 계약은 다음과 같다.

- `path`는 tab에 배정된 root에 대한 canonical 상대 경로다. root 자체는 `.`이며
  `targetKind: "folder"`를 사용한다.
- `targetKind`는 `file` 또는 `folder`이고 set의 `activity`는 `planned`, `active`, `editing`,
  `completed`, `mentioned`, `rejected` 중 하나다.
- workspace 작업에서는 어떤 read/search/edit/test보다 먼저, 작업 전체를 포함하는 completion anchor에
  `planned`를 설정해야 한다. 이후 서로 다른 의미 있는 파일/폴더가 실제 작업 target이 될 때마다 그 작업
  전에 `crispy_saa`를 호출한다. 같은 target/state의 반복 command나 access에는 다시 호출하지 않는다.
  `active`는 읽기·분석·검색·검증·테스트 전에, `editing`은 생성·수정·삭제 전에 사용한다.
- `mentioned`는 Codex 또는 Claude가 자신의 자연어 응답에서 workspace 파일이나 폴더를 언급하기 전에
  사용한다. 단, Target×Session에는 한 상태만 저장되므로 같은 대상이 이미 `planned`, `active`,
  `editing`, `completed`, `rejected`이면 단순히 응답에서 이름을 썼다는 이유로 `mentioned`로
  downgrade하지 않는다. PTY output이나 filesystem change를 감시해 추론하는 상태가 아니다.
- `completed`는 대상 작업과 필요한 검증이 성공했을 때 사용한다. `rejected`는 범위·안전·선행조건
  때문에 의도적으로 취소하거나 건너뛸 때만 사용하며 일반적인 Tool 오류를 뜻하지 않는다.
- 모든 호환 Agent는 요청마다 작업 전체를 포함하는 가장 좁은 공통 target 하나를 completion
  anchor로 정한다. 전체
  요청이 성공하면 최종 응답 전에 이번 요청에서 사용한 anchor 이외의 target을 깊은 순서부터 모두
  `crispy_caa`로 지우고, 마지막 Activity 호출로 anchor만 `completed`로 바꾼다. 다른 요청이나 범위의
  target은 정리하지 않는다. 최종 완료 응답에서 하위 경로를 언급해도 `mentioned` marker를 다시 만들지
  않는다. 이 roll-up 전에 최종 자연어 응답을 시작하거나 anchor `completed` 이후 Activity를 호출하면
  규약 위반이다.
- 필수 initial/transition/cleanup/completion 호출 중 하나라도 빠지면 workspace 작업이 성공했더라도
  Crispy lifecycle 검증에는 실패한다.
- `mentioned`, `completed`, `rejected`는 현재 응답 동안 유지하고 곧바로 clear하지 않는다. 다음
  사용자 요청, 범위 변경, 대상이 더 이상 관련 없게 된 때 또는 rename/delete로 marker가 무효가 된 때
  `crispy_caa`를 호출한다. session 종료 cleanup도 stale state를 best-effort로 지운다.
- 모든 command나 file access마다 호출하지 않는다. 의미 있는 주 작업 대상과 상태 전환만 보고하고,
  가능하면 구체적인 파일/폴더를 사용한다. 넓은 작업에만 folder 또는 root를 사용한다.
- Activity와 자연어 언급 보고는 agent에 전달되는 필수 정책이다. Host는 PTY prose나 filesystem change를
  파싱해 상태를 추론하지 않으며 실제 provider smoke가 자연어 작업의 자율 호출을 검증한다.
- `crispy_ping`은 startup/restart 또는 명시적인 연결 진단에만 한 번 사용하며 정상 작업 중 반복 호출하지
  않는다.
- Tool은 root, session, runtime, URI, token 또는 internal identity를 선택할 수 없다. Host가 현재
  Terminal assignment와 exact lease에서 모두 결정한다.
- Tool success는 child가 handoff 대상으로 수락했다는 뜻이며 Host, Webview, Store 또는 화면의 ACK가
  아니다. `postMessage: true`도 Store delivery proof가 아니다. tracked clear receipt는 Host의
  occupancy/quota 정산 전용 internal signal이며 provider-visible ACK가 아니다.

`crispy_saa`와 `crispy_caa`는 Claude의 `mcp__<server>__<tool>` 완전한 이름을 64자 이하로 유지한다.

credential boundary는 기존 provider 계약을 유지한다. Codex argv에는
`bearer_token_env_var="CRISPY_MCP_TOKEN"` 이름만 들어가고 Claude inline header에는 literal
`Bearer ${CRISPY_MCP_TOKEN}` placeholder만 들어간다. 실제 bearer 값은 final provider environment에만
overlay하며 argv, persisted config, settings, log, telemetry 또는 Webview state에 반사하지 않는다.

구현 제약도 capability qualification의 일부다. Node path walk는 bounded/fail-closed하지만 atomic하지
않아 TOCTOU 가능성이 있고, 같은 `WebviewPanel`의 `postMessage` invocation FIFO를 pinned assumption으로
사용한다. Promise settlement order는 wire ordering이 아니며 public sequence를 추가하지 않는다.
cleanup clear는 best-effort이고, 끝나지 않는 validation/post work는 고정 cap 안에서 detach한 채 quota를
낙관적으로 반환하지 않는다. 지원 범위 밖에서는 이 Activity 경로 전체를 inactive로 유지한다.

minimum, current Stable과 current Insiders Host에서 strict parser와 true/false provider config,
Codex Project/User instruction 보존, 공통 initialize instructions와 Claude의 동일 공통 prompt,
placeholder와 ping 회귀,
HTTP부터 Store receipt/quota까지의 full-chain FIFO,
multi-root 및 Trust/root/restart lifecycle, unsupported zero-state, 실제 provider와 해당 native VSIX
smoke를 검증한다. provider smoke의 prompt는 Tool 이름을 직접 지정하지 않고 `package.json` 읽기를 요청하며
`session.agentActivityRequested`가 실제 발생해야 통과한다. minimum 또는 major boundary를 바꿀 때에는 manifest와
`AGENT_ACTIVITY_MINIMUM_VSCODE_VERSION`을 함께 qualification한다. 상세 순서와 문제 해결은
repository `README.md`와 `SUPPORT.md`를 따른다.

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

- Webview는 MCP/Agent launch에 `cwd`, path 또는 URI를 제공하지 않는다. Host가 탭 assignment의
  `WorkspaceRootId`를 현재 `workspaceFolders`에서 exact lookup하고, structured Codex/Claude와
  credential-free bare plan 모두에 그 fresh path를 사용한다.
- MCP 준비 전, cleanup 전후, fallback 전과 final spawn 직전에 Workspace/Trust를 다시 검증한다.
  Workspace 오류는 structured launch의 실패로 분류해 bare fallback을 유발하지 않으며, 이미 만든
  session runtime과 credential은 정리한다.
- root removal은 실행 중 provider를 자동 종료하지 않지만 다음 MCP restart를 거부한다. Trust revoke는
  Agent와 MCP runtime을 모두 종료하고 assignment와 retry 가능한 error session을 보존한다.
- session마다 최소 256-bit CSPRNG bearer token, opaque route, random loopback port와 generation을
  따로 만들며 파일, settings, Webview state, argv, log와 telemetry에 영속화하지 않는다.
- MCP server는 `127.0.0.1`의 exact random route에서만 요청을 받는다. request-local Tool 등록은
  production Agent Activity capability가 true면 세 Tool, false면 `crispy_ping`만 포함한다.
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

설치 후 VS Code에서 `Developer: Reload Window`를 실행한 다음, 신뢰된 로컬 Workspace에서
`Crispy: Open Canvas`를 열고 root와 `Codex` 또는 `Claude`를 선택한다.

## 자동 smoke 실행

```bash
cd /Users/idonghyeon/crispy
pnpm run prepare:codex-mcp-smoke
pnpm run smoke:codex-mcp
pnpm run smoke:claude-config-compat
pnpm run prepare:claude-mcp-smoke
pnpm run smoke:claude-mcp
```

설치된 VSIX의 Activity 전체 경로는 target이 현재 머신과 일치할 때 다음으로 확인한다.

```bash
pnpm run package:vsix -- --target <darwin-arm64|linux-x64|win32-x64>
pnpm run smoke:installed-vsix -- --target <same-target>
```

이 smoke는 실제 provider 계정 대신 disposable Codex-compatible process를 Canvas UI에서 시작한다.
Host가 발급한 session URL/token으로 ping, 여섯 Activity set과 clear를 호출하고, loopback-only CDP로
실제 Webview의 binding/effect DOM, continuous CSS animation name과 clear 후 제거를 단계별 확인한다.
`--vscode-version stable` 또는 `--vscode-version insiders`로 release channel을 별도 지정할 수 있다.

정상 실행 결과는 다음과 같다.

```text
adapter_ready
awaiting_activity
lifecycle_observed
```

실제 provider smoke는 `src/mcp/toolNames.ts`와 `src/mcp/agentActivityInstructions.ts`를 읽는 자연어
요청을 사용한다. 성공하려면 `src/mcp` planned anchor, 두 파일의 active, 두 파일 clear, 마지막
`src/mcp` completed가 모두 관찰되어야 하며 이후 Activity 호출이 없어야 한다.

설치된 Codex의 config parsing, node-pty 실행 경계와 effective developer instruction 보존을 확인하려면
다음을 실행한다.

```bash
pnpm run smoke:codex-config-compat
```

정상 출력 예시는 다음과 같다.

```text
[codex-config-compat-smoke] keyed-filters config parsed through node-pty.
[codex-config-compat-smoke] Host graph authority and Workspace AGENTS.md precedence passed for both Activity gates.
```

Windows에서는 설치된 실제 `codex.cmd`의 config parsing과, 특수문자 경로에 둔
독립 fixture의 `cmd.exe` one-shot 인자 보존을 분리해 검증한다.

```text
[codex-config-compat-smoke] keyed-filters config parsed through node-pty.
[codex-config-compat-smoke] Host graph authority and Workspace AGENTS.md precedence passed for both Activity gates.
[codex-config-compat-smoke] Windows cmd-one-shot special-path launch passed.
```

version probe가 실패하면 `spawn_error`, `exit_nonzero`, `timeout`,
`unparsable_version`처럼 credential을 포함하지 않는 원인이 출력된다.

`smoke:claude-config-compat`는 로그인이나 token 없이 설치된 Claude의 bounded version gate와
공식 `--mcp-config`/`--strict-mcp-config` CLI surface를 검사한다. macOS 15, Ubuntu 24.04,
Windows 2025의 scheduled workflow도 최신 Claude에 이 smoke를 실행한다. 이 검사는 authenticated
header expansion을 대신하지 않으며, 그 계약은 `smoke:claude-mcp`의 positive/negative transaction이
검증한다.

production/VSIX와 process cleanup까지 포함한 release 확인은 다음 순서로 실행한다.

```bash
pnpm run check-types
pnpm run lint
pnpm run test
pnpm run package
pnpm run package:vsix -- --target darwin-arm64
pnpm run inspect:vsix -- --target darwin-arm64
pnpm run smoke:pty-kill
pnpm run smoke:codex-config-compat
pnpm run smoke:claude-config-compat
pnpm run prepare:codex-mcp-smoke
pnpm run smoke:codex-mcp
pnpm run prepare:claude-mcp-smoke
pnpm run smoke:claude-mcp
pnpm run smoke:installed-vsix -- --target darwin-arm64
```

실제 Codex/Claude smoke는 로그인된 provider와 loopback/PTY 실행 권한이 필요하므로 일반 CI unit
gate와 구분한다. C5 gate가 완료된 뒤에만 Claude L0을 시작한다.

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
- 이 2026-08-22 L0 검증 시점의 Crispy Claude server는 공통 server가 등록한
  `crispy_ping` 하나만 대상으로 삼았다. `alwaysLoad`는 이 작은 inline server에만 적용했다.
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
- 당시 공통 MCP protocol server의 `crispy_ping`, authenticated activity 판정과 failure domain

L1에서 추가할 최소 provider surface는 `src/mcp/**`의 Claude inline-config serializer,
bare/authenticated launch-plan builder, 좁은 diagnostic matcher와 실제 smoke runner다. 새 unit test와
fixture는 `src/test/**`에만 둔다. L2에서 Terminal Host의 Codex 전용 orchestration 이름과 generation
map을 provider-neutral session orchestration으로 좁게 일반화하고 Extension wiring에 Claude
preparation을 추가한다. L3 전에는 Claude status/retry UI를 연결하지 않는다.

### L1 실제 smoke 계획

1. 공통 supervisor가 준비한 current random URL/token으로 token-free inline JSON을 만든다.
2. `claude`를 node-pty의 direct root process로 실행하고 token은 environment에만 넣는다.
3. Tool 이름을 직접 지시하지 않는 두 파일 읽기 요청으로 config 인식, HTTP header expansion과
   `planned → active children → clear children → completed anchor` 전체 lifecycle을 확인한다.
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

## Claude Phase L4 최종 검증 기록 — 2026-08-22

현재 macOS Apple Silicon 실기 환경은 macOS `26.5.2`, Codex `0.149.0`, Claude Code
`2.1.239`다. 프로젝트가 요구하는 Node `24.x` 전체 회귀는 Codex desktop bundled Node
`24.19.0`과 저장소 고정 pnpm `11.18.0`으로 다시 실행한다. L4에서 확인한 provider 결과는
다음과 같다.

Node `24.19.0`에서 typecheck, ESLint, production bundle과 VS Code Extension Test Suite의
`1054 passing`을 확인했다.

| provider/binary | L4 결과 |
| --- | --- |
| Codex `0.149.0` | keyed filter config가 node-pty에서 parse되고 실제 `crispy_ping` authenticated activity 성공 |
| Claude 현재 설치 `2.1.239` | version/config surface, inline header env expansion, `crispy_ping`, authenticated activity 성공; token env 제거 시 activity 없음 |
| Claude 격리 설치 `2.1.121` | inclusive minimum gate와 위 positive/negative MCP transaction 재통과; 사용자 설치를 덮어쓰지 않고 임시 설치 제거 |
| Claude fake versions | `2.1.120`, probe spawn failure/timeout/unparsable은 credential 없는 bare fail-open, `2.1.121`과 임의의 더 높은 버전은 상한 없이 compatible |

`Provider CLI config and launch compatibility` workflow는 최신 Codex와 최신 Claude를 각각
macOS 15, Ubuntu 24.04, Windows 2025에 설치한다. Claude job은 로그인 secret 없이 version gate와
session config CLI surface를 검증하고, Codex job은 config parsing과 node-pty launch를 검증한다.
실제 Claude MCP 인증은 로컬 login-required smoke로 분리한다.

현재 macOS에서 production bundle, `darwin-arm64` VSIX 생성/78-entry archive inspection,
VS Code `1.125.0` clean-profile installed VSIX의 PTY input/output/resize/exit와 MCP child port cleanup,
process-tree kill smoke를 통과했다. Linux x64 glibc와 Windows native x64의 installed VSIX 및
최신 Claude 실기 workflow는 이 로컬 macOS 실행에서는 `not_run`이다. cross packaging은 저장소가
의도적으로 거부하므로 각 native GitHub Actions runner에서 실행해야 하며, 이 변경 자체의 remote
workflow run은 commit/push 전이라 아직 수행되지 않았다.

이 문단은 2026-08-22 당시 Codex C0→C5와 Claude L0→L4 검증 범위를 기록한다. 그 L4 범위에는
사용자-visible `provider_update_required` emit/update 정책과 Graph report tool/state 연결이
포함되지 않았다. 이후 2026-08-26 Phase 5에서 VS Code Host capability로 제한한 Codex/Claude
Agent Activity Tool과 Graph/Store 연결을 추가했으며 현재 계약은 문서 앞부분의
`Phase 5 production Agent Activity 계약`을 따른다.

## Task Work 공통 Tool 규약 주입 — 2026-08-27

Task lease가 있는 세션만 `crispy_task_complete`, `crispy_task_scope_request`,
`crispy_task_scope_result`를 `crispy_ping`과 함께 등록한다. 등록 여부와 같은 Host-owned boolean으로
공통 Task Tool 규약을 생성하며, MCP initialize `instructions`, Codex
`developer_instructions`, Claude `--append-system-prompt`가 정확히 같은 문자열을 사용한다. Task와
Agent Activity가 모두 활성인 세션은 Task 규약 뒤에 기존 Activity 규약을 합성한다.

Claude가 모델에 전달하는 MCP Tool 이름은 `mcp__<server>__<tool>`이고 64자 상한을 갖는다. 기존
46자 `crispy_canvas_<32 hex>` server 이름에서는 Task Tool의 완전한 이름이 73~78자가 되어 Tool
규약과 permission allowlist가 있어도 모델의 유효 Tool 정의가 될 수 없었다. Claude 전용 server
이름을 96-bit random을 유지하는 31자 `crispy_<24 hex>`로 제한해 세 Task Tool을 각각
58·63·62자로 만든다. server 이름은 credential이 아니며 route와 bearer token의 기존 entropy와
수명은 변경하지 않는다. 생성·검증·permission·smoke·startup diagnostic은 한 validator를 사용하고,
완전한 Tool 이름이 64자를 넘으면 provider launch 전에 거부한다. Codex server 이름은 변경하지 않는다.

provider-neutral Task prompt에는 작업 제목·prompt와 배정된 참조/작업 영역을 둔다. Codex와 Claude
launch 경로는 그 원문 뒤에 한 문단의 completion reminder를 추가해 마지막 action으로
`crispy_task_complete`를 호출하고 accepted 호출 전에는 Work가 끝나지 않는다고 명시한다. 이전의 긴
별도 실행 계약은 복원하지 않는다. 참조 영역은 read-only, 작업 영역만 read-write이며, 그 밖의 접근은
scope request의 `requestId`와 provider의 일반 permission UI 결과를 scope result로 연결한다. scope
request 자체는 권한을 부여하지 않는다.

성공 또는 의도적인 범위/사용자 거절의 terminal outcome에서는 실제 `crispy_task_complete` 호출만
Host scheduler를 진행시킨다. 자연어 완료 응답은 완료 신호가 아니며, accepted completion이 Task 소유
process를 종료하므로 필요한 Activity cleanup 뒤 마지막 Tool 호출로 보낸다. Task 도구가 없는 일반
세션은 이 규약을 받지 않으며 기존 Activity-only 또는 ping-only instructions를 유지한다.

### Provider turn lifecycle adapter

Task 세션은 completion Tool 누락을 provider 응답 종료 경계에서 복구한다. Codex는 Task launch에만
`agent-turn-complete` OSC 9 TUI 알림을 켜고 Terminal Host가 raw PTY chunk를 파싱한다. 알림 후 250ms
동안 exact completion IPC를 기다린 다음, 없으면 같은 PTY에 completion 후속 메시지를 최대 두 번 쓴다.
세 번째 prose-only 종료는 Work 실패다. 이 경로는 별도 프로세스나 app server를 시작하지 않는다.

Claude는 Task session inline settings에 HTTP `Stop`/`StopFailure` hook을 넣는다. URL은 그 세션 MCP
child의 route에 종속된 sibling loopback route이고 기존 bearer token 환경 변수로 인증한다. child는
MCP Tool 호출과 hook 요청을 함께 관찰하므로 completion이 이미 수락됐거나 scope request가 미결이면
Stop을 그대로 통과시킨다. 그렇지 않으면 qualified completion Tool 이름을 provider-native
`decision: block`의 `reason`으로 최대 두 번 반환한다. `StopFailure` 또는 reminder 소진은 exact child
IPC로 Host에 전달되어 Work를 실패 처리한다. HTTP hook과 StopFailure가 도입된 버전은 기존 Claude
최소 호환 버전보다 이전이며, 더 최신 버전에만 있는 Stop additional-context 표면에는 의존하지 않는다.

turn event 자체는 scheduler 완료 근거가 아니다. generation, session, execution, Work identity가 모두
현재 lease와 일치하는 이벤트만 관찰하며, 실제 scheduler 전이는 기존 Task Tool event만 담당한다.
scope request가 미결인 동안 받은 completion도 lifecycle completion으로 기록하지 않는다.
