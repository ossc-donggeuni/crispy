# Crispy

Crispy는 VS Code Workspace의 프로젝트 구조를 **중첩 가능한 박스 기반 Graph View**로 시각화하는 VS Code Extension입니다.

일반적인 세로형 파일 트리 대신 디렉터리, 파일, 파일 내부 코드 요소를 하나의 Canvas에서 탐색할 수 있습니다.

현재 버전에서는 실제 Workspace의 디렉터리와 파일을 분석하고, 지원되는 파일을 펼쳤을 때 VS Code Document Symbol Provider를 통해 최상위 함수·클래스 등의 선언을 표시합니다.

---

## 실행 방법

### 1. 요구 환경

* VS Code Desktop
* Node.js
* pnpm

pnpm이 준비되어 있지 않다면 Corepack을 활성화합니다.

```bash
corepack enable
```

### 2. 의존성 설치

Crispy 저장소 루트에서 실행합니다.

```bash
pnpm install
```

### 3. Extension 실행

VS Code에서 Crispy 저장소를 연 뒤 다음 순서로 실행합니다.

1. VS Code의 **Run and Debug** 탭을 엽니다.
2. 실행 구성에서 **Run Extension**을 선택합니다.
3. `F5`를 누릅니다.
4. 새로운 **Extension Development Host** 창이 열립니다.
5. 분석할 프로젝트 폴더를 엽니다.
6. Command Palette를 엽니다.
7. 다음 명령을 실행합니다.

```text
Crispy: Open Graph View
```

Crispy Graph Webview가 Editor 탭에 열리고 현재 Workspace의 프로젝트 구조를 분석하여 표시합니다.

Workspace를 열지 않은 상태에서 Crispy를 실행하면 다음 안내와 함께 폴더 선택 버튼이 표시됩니다.

```text
No workspace opened.
```

#### Codex Chat 확인

Chat만 열려면 Command Palette에서 다음 명령을 실행합니다.

```text
Crispy: Open Chat View
```

Graph와 Chat을 각각 독립된 Webview로 동시에 열려면 다음 명령을 실행합니다.

```text
Crispy: Open Graph and Chat Views
```

동시 열기 명령은 Graph를 현재 Editor Group에, Chat을 옆 Editor Group에 배치합니다. 두 영역의 크기는 VS Code Editor Group 구분선을 드래그해 조절할 수 있고, Editor Layout 메뉴를 사용하면 좌우 또는 상하 배치로 변경할 수 있습니다.

현재 Chat은 UI 검토 단계입니다. 메시지 입력, 전송·실행 중지 전환, 승인·거부 UI는 로컬 상태로 동작하며 실제 Codex 실행은 아직 연결되지 않았습니다.

### 4. 개발 중 자동 빌드

Extension과 Graph·Chat Webview를 변경하면서 자동으로 다시 빌드하려면 다음 명령을 사용합니다.

```bash
pnpm run watch:esbuild
```

Watch 작업은 파일 변경을 기다리기 때문에 빌드가 끝나도 프로세스가 종료되지 않습니다.

### 5. 수동 빌드

Extension 배포용 번들을 생성합니다.

```bash
pnpm run package
```

### 6. 검증 명령

타입 검사:

```bash
pnpm run check-types
```

Lint:

```bash
pnpm run lint
```

테스트:

```bash
pnpm test
```

전체 검증 예시:

```bash
pnpm run check-types
pnpm run lint
pnpm run package
pnpm test
```

---

## 현재 구현된 기능

### 실제 Workspace 구조 분석

현재 열려 있는 단일 VS Code Workspace의 디렉터리와 파일을 분석합니다.

Workspace 접근에는 VS Code FileSystem API를 사용합니다.

```text
vscode.workspace.fs.readDirectory()
```

분석 결과는 `ProjectNode[]` 구조로 변환되어 Webview의 Graph View에 전달됩니다.

기본 구조:

```text
Project
└─ Directory
   ├─ Directory
   └─ File
      └─ Symbol
```

현재는 단일 Workspace Folder를 지원합니다.

Multi-root Workspace는 아직 지원하지 않습니다.

---

### 중첩 박스 기반 Graph View

프로젝트 구조를 일반적인 세로 파일 트리 대신 중첩 가능한 박스와 Bubble로 표시합니다.

현재 지원하는 조작은 다음과 같습니다.

* Canvas Pan
* Canvas Zoom
* Fit View
* 프로젝트 박스 이동
* 디렉터리 박스 이동
* 파일 상세 박스 이동
* 디렉터리 펼침 및 접기
* 여러 디렉터리 동시 펼침
* 파일 상세 펼침 및 접기
* 프로젝트·디렉터리·파일·Symbol 선택
* 빈 Canvas 클릭을 통한 선택 해제

사용자가 이동시킨 박스 위치는 Fit View를 실행해도 초기화되지 않습니다.

---

### 디렉터리와 파일 표시

디렉터리는 중첩 가능한 박스로 표시됩니다.

디렉터리 내부의 하위 폴더와 파일은 수평 Bubble 또는 Card 형태로 표시됩니다.

```text
Project Box
└─ Directory Box
   ├─ Directory Bubble
   ├─ File Bubble
   └─ Nested Directory Box
```

하나의 디렉터리를 열어도 기존에 열려 있던 다른 디렉터리는 닫히지 않습니다.

---

### 파일 내부 코드 요소 분석

파일을 펼치면 VS Code의 Document Symbol Provider를 이용해 파일 내부 선언을 분석합니다.

사용 API:

```text
vscode.executeDocumentSymbolProvider
```

Crispy가 자체 AST Parser를 실행하거나 파일 내용을 직접 파싱하지는 않습니다.

현재 표시 대상:

* Function
* Class
* Method
* Constructor
* Interface
* Enum
* Struct
* Module

MVP에서는 Provider가 반환한 최상위 선언만 표시합니다.

중첩 함수나 클래스 내부의 전체 Symbol 계층은 재귀적으로 표시하지 않습니다.

Symbol은 실제 소스 선언 위치를 기준으로 정렬됩니다.

화면에 표시되는 줄 번호는 1부터 시작합니다.

---

### 파일 분석 상태

파일별 분석 상태를 다음과 같이 구분합니다.

| 상태            | 의미                           |
| ------------- | ---------------------------- |
| `loading`     | 파일 구조 분석 중                   |
| `ready`       | 분석 완료                        |
| `unsupported` | Document Symbol Provider 미지원 |
| `failed`      | 분석 도중 오류 발생                  |

표시 예시:

```text
Analyzing file structure...
```

```text
No supported top-level symbols found.
```

```text
Internal analysis is not supported for this file.
```

```text
File analysis failed.
Retry
```

분석에 실패한 파일은 Retry를 통해 다시 요청할 수 있습니다.

같은 파일에 대한 중복 분석 요청은 방지되며, 오래된 요청의 결과는 적용하지 않습니다.

파일을 접었다가 다시 펼치면 이미 분석된 결과를 재사용합니다.

---

### 분석 중 Graph 상태 유지

Document Symbol 분석 결과는 기존 GraphView 인스턴스에 부분적으로 적용됩니다.

분석 결과가 도착해도 다음 상태가 유지됩니다.

* 사용자가 이동시킨 박스 위치
* Canvas Viewport
* Zoom 비율
* 펼쳐진 디렉터리
* 펼쳐진 파일
* 현재 선택된 노드
* 기존 Plan 강조 입력

GraphView 전체를 다시 생성하지 않기 때문에 분석 전후로 사용자의 Canvas 상태가 초기화되지 않습니다.

---

### 노드 선택 메시지

Graph에서 노드를 선택하면 Webview가 Extension Host로 선택 정보를 전달합니다.

메시지 형식:

```ts
{
  type: "selectionChanged",
  payload: {
    selectedNodeId?: string;
  }
}
```

파일 선택 예시:

```text
file:src/extension.ts
```

Symbol 선택 예시:

```text
function:src/extension.ts:activate:345
```

선택된 노드는 VS Code의 **Output** 패널에서 확인할 수 있습니다.

1. `View`
2. `Output`
3. Output Channel에서 `Crispy` 선택

출력 예시:

```text
[Crispy] Selected node: directory:src
[Crispy] Selected node: file:src/extension.ts
[Crispy] Selected node: function:src/extension.ts:activate:345
[Crispy] Selection cleared
```

---

## 노드 데이터 구조

프로젝트 구조는 다음 타입을 기준으로 표현됩니다.

```ts
export type ProjectNode = {
  id: string;
  type: "project" | "application" | "directory" | "file" | "symbol";
  name: string;
  relativePath?: string;
  parentId?: string;
  childrenIds: string[];
};
```

### 디렉터리 ID

```text
directory:src
directory:src/webview
directory:src/webview/components
```

### 파일 ID

```text
file:package.json
file:src/extension.ts
file:src/webview/main.ts
```

### Symbol ID

```text
function:<relativePath>:<encodedSymbolName>:<startLine>
```

예:

```text
function:src/extension.ts:activate:345
```

모든 경로는 Workspace 기준 상대 경로를 사용하며 경로 구분자는 `/`로 통일합니다.

운영체제의 절대 경로는 노드 ID에 포함하지 않습니다.

---

## Workspace 분석 제외 항목

다음 디렉터리는 기본적으로 프로젝트 구조 분석에서 제외됩니다.

```text
.git
node_modules
.next
dist
out
build
coverage
.pnpm-store
.vscode-test
__MACOSX
```

다음 파일도 제외됩니다.

```text
.DS_Store
```

Symbolic Link는 순환 탐색을 방지하기 위해 노드를 만들거나 재귀적으로 분석하지 않습니다.

---

## 프로젝트 구조

```text
src/
├─ extension.ts
│
├─ model/
│  ├─ projectNode.ts
│  ├─ webviewMessage.ts
│  └─ fileAnalysis.ts
│
├─ workspace/
│  ├─ projectScanner.ts
│  └─ documentSymbolAnalyzer.ts
│
├─ webview/
│  ├─ main.ts
│  ├─ GraphView.ts
│  ├─ fileAnalysisState.ts
│  ├─ styles.css
│  └─ components/
│     ├─ ProjectBox.ts
│     ├─ DirectoryBox.ts
│     ├─ StructureBubble.ts
│     ├─ FileDetailBox.ts
│     ├─ SymbolBlock.ts
│     ├─ GraphToolbar.ts
│     └─ componentTypes.ts
│
└─ test/
   ├─ extension.test.ts
   ├─ projectScanner.test.ts
   ├─ documentSymbolAnalyzer.test.ts
   └─ fileAnalysisState.test.ts
```

### 주요 모듈

#### `src/extension.ts`

* Extension 활성화
* Crispy Webview Panel 관리
* Panel 중복 생성 방지
* CSP 및 nonce 구성
* Workspace 구조 분석 요청 처리
* 파일 내부 분석 요청 처리
* Webview 메시지 수신
* Crispy Output Channel 관리

#### `src/workspace/projectScanner.ts`

* 실제 Workspace 디렉터리와 파일 재귀 탐색
* 제외 디렉터리 처리
* `ProjectNode[]` 생성
* 디렉터리 우선 정렬
* Workspace 상대 경로 기반 ID 생성

#### `src/workspace/documentSymbolAnalyzer.ts`

* 파일 URI 검증
* Workspace 외부 경로 접근 차단
* Document Symbol Provider 실행
* 지원 Symbol 종류 필터링
* Symbol 선언 순서 정렬
* Symbol 노드와 메타데이터 생성

#### `src/webview/GraphView.ts`

* Graph Canvas 상태 관리
* Pan·Zoom·Fit View
* 노드 선택
* 디렉터리와 파일 펼침 상태
* 박스 위치 관리
* 파일 분석 요청
* 분석 결과 부분 반영

#### `src/webview/main.ts`

* Extension Host와 Webview 사이의 메시지 전달
* 실제 Workspace 노드를 GraphView에 주입
* 선택 변경 메시지 전송
* 파일 분석 요청 전송
* 분석 결과 수신

---

## 테스트

현재 다음 동작을 테스트합니다.

* Crispy 명령 등록
* Webview Panel 중복 생성 방지
* Panel 종료 및 재실행
* Workspace 구조 스캔
* 프로젝트·디렉터리·파일 노드 생성
* 부모·자식 노드 연결
* 제외 디렉터리 처리
* Document Symbol 정규화
* 지원하지 않는 Symbol 종류 제외
* Symbol 선언 순서 정렬
* Symbol ID 생성
* 파일 분석 상태 전이
* 중복 분석 요청 방지
* 오래된 요청 결과 무시
* Retry 요청
* Webview 메시지 런타임 검증

테스트 실행:

```bash
pnpm test
```

---

## 현재 제한사항

현재 버전에는 다음 제한이 있습니다.

* 단일 Workspace Folder만 지원합니다.
* Multi-root Workspace는 지원하지 않습니다.
* Symbol 분석 결과는 설치된 언어 Extension과 Document Symbol Provider에 따라 달라집니다.
* 파일 내부에서는 최상위 선언만 표시합니다.
* Crispy 자체 AST Parser는 제공하지 않습니다.
* 함수 호출 관계와 Import 관계는 분석하지 않습니다.
* 파일 변경에 따른 자동 Graph 새로고침은 아직 지원하지 않습니다.
* Graph 위치를 VS Code 재실행 후 복원하지 않습니다.
* 선택한 파일이나 Symbol의 실제 Editor 위치로 이동하는 기능은 아직 없습니다.

---

## 아직 구현되지 않은 기능

현재 Crispy는 실제 프로젝트 코드 구조를 분석하고 탐색하는 기반까지 구현되어 있습니다.

다음 기능은 아직 구현되지 않았습니다.

* Codex Plan Mode 연동
* Claude Code Plan Mode 연동
* Agent Plan 출력 수집
* Agent 출력을 공통 Change Plan으로 변환
* Task UI
* Task와 실제 코드 노드 매핑
* 직접 변경·읽기 참고·영향 가능 대상 표시
* 생성·수정·삭제 예정 표시
* Task 선택 시 관련 코드 강조
* 코드 선택 시 관련 Task 강조
* Plan 검토·수정·승인
* Agent 실제 실행
* 실행 과정 실시간 시각화
* 승인한 Plan과 실제 변경 결과 비교
* 위험 변경 감지

---

## 현재 개발 단계

현재까지 구현된 흐름:

```text
VS Code Workspace 열기
→ 디렉터리·파일 구조 분석
→ ProjectNode[] 생성
→ GraphView 표시
→ 파일 펼치기
→ Document Symbol 분석
→ 최상위 코드 선언 표시
→ 코드 노드 선택 정보 전달
```

다음 개발 목표:

```text
Agent Plan Mode 출력 수집
→ 공통 Change Plan 변환
→ Task와 실제 코드 노드 매핑
→ 프로젝트 구조 위에 Agent Plan 표시
```
