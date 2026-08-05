# Crispy Codex Agent Runner

VS Code Extension Host에서 Codex CLI를 실행하고, 실행 중 발생하는 JSONL 이벤트를 Crispy 공통 이벤트로 전달한 뒤, 검증된 `ChangePlan`과 실행 정보를 반환하는 모듈입니다.

현재는 Codex만 지원합니다. 이후 Claude Code를 연결할 때도 `AgentEvent`, `ChangePlan`, 실행 결과 형식은 재사용하고 Provider 실행 명령과 원본 이벤트 변환부만 확장하는 것을 목표로 합니다.

## 주요 기능

- 사용자 요청과 Crispy 공통 Plan 프롬프트 결합
- 지정한 VS Code Workspace에서 Codex 실행
- stdout JSONL 실시간 파싱
- Provider 원본 이벤트를 공통 `AgentEvent`로 변환
- 마지막 유효 `agent_message.text`에서 `ChangePlan` 추출
- JSON Schema와 Crispy 규약 Validator 적용
- stdout과 stderr 분리 수집
- `AbortSignal` 취소와 기본 5분 timeout
- Extension 종료 시 실행 중인 Codex process tree 정리
- macOS, Linux, Windows의 프로세스 종료 방식 구분

## 실행 흐름

```text
사용자 prompt
→ common-plan.md의 {{USER_PROMPT}}와 결합
→ Workspace 경로에서 codex exec 실행
→ stdout JSONL을 한 줄씩 파싱
→ AgentEvent를 onEvent로 실시간 전달
→ 마지막 유효 ChangePlan 후보 선택
→ JSON Schema 검사
→ Crispy Validator 검사
→ AgentRunResult 반환
```

Codex는 다음 옵션으로 실행됩니다.

```text
codex exec
  --json
  --output-schema <ChangePlan Schema 경로>
  -C <Workspace 경로>
  -s read-only
  --skip-git-repo-check
  --color never
  -
```

결합된 프롬프트는 shell 인자가 아니라 stdin으로 전달됩니다. Workspace는 `read-only` sandbox로 열리므로 Plan 생성 과정에서 프로젝트 파일을 변경하지 않습니다.

## 실행 전제

- Node.js와 프로젝트 의존성이 설치되어 있어야 합니다.
- Codex CLI가 시스템 `PATH`에서 `codex`라는 이름으로 실행 가능해야 합니다.
- 실제 Codex 실행 전 로그인이 완료되어 있어야 합니다.

확인 명령:

```bash
codex --version
codex login status
```

로그인이 필요하면 다음 명령을 사용합니다.

```bash
codex login
```

Codex 설치 또는 로그인 UI는 이 모듈의 책임에 포함하지 않습니다. 실행할 수 없거나 인증이 실패하면 `AgentRunResult.status`가 `failed`가 되고 원인이 `error`와 `stderr`에 담깁니다.

## 기본 사용법

```ts
import { runCodex } from './agent/runCodex';

const controller = new AbortController();

const result = await runCodex(
  '환경 설정 로딩 방식을 개선하기 위한 작업 계획을 작성해 주세요.',
  {
    workspaceRoot: workspaceFolder.uri.fsPath,
    signal: controller.signal,
    onEvent: (event) => {
      // Webview나 진행 상태 저장소에 공통 이벤트를 전달합니다.
      console.log(event);
    },
  },
);

if (result.status === 'completed') {
  console.log(result.plan);
} else {
  console.error(result.error, result.stderr);
}
```

사용자가 실행을 취소하면 같은 `AbortController`를 사용합니다.

```ts
controller.abort();
```

현재 UI는 구현 범위에 포함되지 않았으므로 실제 제품 연결 단계에서 Webview 입력창, 진행 이벤트 표시, 취소 버튼을 위 API에 연결해야 합니다.

## 공개 API

### `runCodex(prompt, options)`

```ts
async function runCodex(
  prompt: string,
  options: {
    workspaceRoot: string;
    onEvent?: (event: AgentEvent) => void;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<AgentRunResult>;
```

옵션:

| 필드 | 설명 |
| --- | --- |
| `workspaceRoot` | Codex가 분석할 Workspace 절대 경로 |
| `onEvent` | 실행 중 변환된 `AgentEvent`를 받는 콜백 |
| `signal` | 실행 취소에 사용하는 `AbortSignal` |
| `timeoutMs` | 실행 제한 시간. 생략하면 5분 |

`onEvent`가 예외를 던지더라도 Codex 프로세스 수명주기와 최종 결과에는 영향을 주지 않습니다.

### `disposeCodexRuns()`

```ts
async function disposeCodexRuns(): Promise<void>;
```

현재 Extension Host에서 실행 중인 모든 Codex process tree를 종료하고 프로세스의 `close`까지 기다립니다. `src/extension.ts`의 `deactivate()`에서 호출됩니다.

## AgentEvent

```ts
type AgentEvent =
  | { type: 'status'; message: string }
  | { type: 'tool'; name: AgentToolName; target?: string }
  | { type: 'message'; text: string }
  | { type: 'plan'; plan: ChangePlan }
  | { type: 'error'; message: string };
```

도구 이벤트는 Provider 명령 원문 대신 다음 공통 이름으로 전달됩니다.

| 이름 | 의미 |
| --- | --- |
| `list_files` | 파일과 디렉터리 목록 조회 |
| `read_file` | 파일 내용 읽기 |
| `search_code` | 문자열이나 코드 검색 |
| `run_command` | 나머지 읽기 전용 명령 |

`target`은 Workspace 상대 경로를 안전하게 확인할 수 있을 때만 포함됩니다.

## AgentRunResult

```ts
interface AgentRunResult {
  provider: 'codex';
  status: 'completed' | 'failed' | 'cancelled' | 'timed-out';
  exitCode: number | null;
  stderr: string;
  parseFailureCount: number;
  plan?: ChangePlan;
  error?: string;
}
```

상태 판정:

| 상태 | 조건 |
| --- | --- |
| `completed` | exit code 0, 취소·timeout 없음, 마지막 유효 Plan 추출 및 검증 성공 |
| `failed` | 입력·asset·spawn·종료 코드·Plan 추출·검증 중 하나가 실패 |
| `cancelled` | AbortSignal 또는 Extension 종료가 먼저 발생 |
| `timed-out` | 제한 시간이 먼저 발생 |

`plan`은 `completed`에서만 제공하고, 나머지 상태에는 `error`를 제공합니다. stderr 또는 일부 JSONL 파싱 실패만으로는 실행을 실패 처리하지 않습니다.

## ChangePlan 추출과 검증

다음 원본 이벤트만 Plan 후보로 검사합니다.

```text
event.type = item.completed
item.type = agent_message
```

모든 후보를 끝까지 확인하고 다음 단계를 모두 통과한 마지막 Plan을 사용합니다.

```text
item.text
→ JSON.parse
→ changePlan.schema.json
→ Crispy 교차 필드 Validator
→ 최종 ChangePlan
```

JSONL 한 줄 자체가 JSON이 아니면 `parseFailureCount`를 증가시키고 다음 줄을 계속 처리합니다. 정상 JSONL 안의 `agent_message.text`가 JSON이 아닌 경우는 Plan 후보 실패이며 `parseFailureCount`에 포함하지 않습니다.

### JSON Schema 검사

`changePlan.schema.json`은 필수 필드, 타입, enum, 배열과 객체 구조를 검사합니다. 같은 Schema가 Codex의 `--output-schema`와 런타임 Ajv 검사에 사용됩니다.

### Crispy Validator 검사

JSON Schema로 표현하기 어려운 다음 관계를 검사합니다.

- Task ID와 order 순서
- Workspace 상대 경로와 `codeNodeId` 연결
- Task 대상 배열과 `targetNodes` 연결
- relation과 changes 일관성
- 수정·생성·삭제·참고 목록 연결
- unresolved 대상 규칙
- `taskIds` 참조와 중복
- `isAdditionalCandidate`와 사용자 경로 언급 관계

검증에 실패한 Plan은 자동 수정하지 않고 최종 후보에서 제외합니다.

## 파일 구성

| 파일 | 역할 |
| --- | --- |
| `runCodex.ts` | Codex 프로세스 실행과 전체 수명주기 관리 |
| `codexEventParser.ts` | JSONL 파싱, 이벤트 변환, 마지막 유효 Plan 추적 |
| `agentTypes.ts` | ChangePlan, AgentEvent, AgentRunResult 공통 타입 |
| `agentAssets.ts` | 프롬프트·Schema asset 탐색과 사용자 요청 결합 |
| `changePlanValidator.ts` | Ajv 구조 검사와 Crispy 교차 필드 검사 |
| `changePlan.schema.json` | Codex와 런타임이 공유하는 ChangePlan Schema |
| `common-plan.md` | Codex에 전달하는 공통 Plan 생성 규약 |
| `__tests__/` | 단위·프로세스 수명주기·실제 Codex 통합 테스트 |

`common-plan.md`와 `changePlan.schema.json`은 빌드 시 `dist/agent/`로 복사됩니다. 설치 위치에 관계없이 번들 디렉터리를 기준으로 asset을 찾습니다.

## 테스트

### 기본 테스트

```bash
pnpm test
```

외부 Codex 호출 없이 가짜 프로세스를 사용해 다음 동작을 확인합니다.

- 프롬프트 asset 로딩과 placeholder 치환
- JSONL chunk, malformed line, 마지막 미개행 줄
- 마지막 유효 Plan 선택
- 이벤트 정규화
- Schema와 Crispy Validator
- stdout과 stderr 분리
- CLI 실행 실패와 non-zero 종료
- 취소, timeout, dispose
- `onEvent` 예외 격리

### 실제 Codex 통합 테스트

```bash
pnpm run test:integration:codex
```

`__tests__/fixtures/integration-user-prompt.md`의 자연어 요청과 테스트용 임시 Workspace를 사용합니다. 다음 항목을 확인합니다.

- 실제 Codex CLI 실행
- 실시간 tool과 plan 이벤트
- 수정·생성·삭제 대상이 포함된 ChangePlan
- Schema와 Validator 통과
- 실행 전후 Workspace 무변경

임시 Workspace는 OS 임시 디렉터리에 생성되고 테스트 종료 시 삭제되므로 Extension Development Host의 Explorer에는 표시되지 않습니다.

### Production 빌드

```bash
pnpm run package
```

빌드 후 다음 asset이 생성되어야 합니다.

```text
dist/agent/common-plan.md
dist/agent/changePlan.schema.json
```

## 이번 구현에서 제외한 범위

- Claude Code 연동
- 사용자 prompt 입력 Webview
- Agent 대화 및 진행 화면
- Task 목록과 GraphView 표시
- Plan 승인과 실제 코드 실행
- Plan 대상과 ProjectNode 매핑
- 변경 전후 비교
- 다중 Agent 오케스트레이션

이후 UI 구현에서는 `runCodex()`의 `onEvent`를 진행 화면에 연결하고, 취소 버튼을 `AbortController`에 연결하며, 완료된 `ChangePlan`을 표시하면 됩니다.
