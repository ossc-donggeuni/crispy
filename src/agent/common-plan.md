# Crispy ChangePlan 생성 요청

현재 VS Code Workspace의 코드를 읽고, 사용자 요청을 구현하기 위한 작업 계획을 ChangePlan으로 작성해 주세요.

이번 요청에서는 실제 코드를 변경하지 않고 계획만 작성합니다.

## 작업 범위

- Workspace의 파일과 디렉터리를 읽고 검색하여 현재 구조를 파악해도 됩니다.
- 파일 읽기, 파일 목록 조회, 문자열 검색 등 읽기 전용 작업을 수행해도 됩니다.
- Workspace의 파일을 생성, 수정하거나 삭제하지 마세요.
- 패키지를 설치하거나 의존성을 변경하지 마세요.
- 개발 서버, 빌드, 린트와 테스트를 실행하지 마세요.
- 사용자 요청을 실제로 구현하지 말고 구현 계획만 반환해 주세요.
- Workspace 외부에 실행 도구가 자체 관리용 파일을 생성하더라도, ChangePlan에는 Workspace 변경 계획만 포함해 주세요.

## 최종 응답 방식

- 최종 응답은 아래 형식의 JSON 객체 하나로 작성해 주세요.
- Markdown 코드블록을 사용하지 마세요.
- JSON 앞뒤에 설명이나 인사말을 추가하지 마세요.
- 중간 진행 메시지가 필요한 환경에서도 최종 메시지는 완전한 JSON 객체 하나여야 합니다.
- 모든 필수 필드를 포함해 주세요.
- 항목이 없는 배열은 `[]`로 작성해 주세요.
- nullable로 정의된 값만 `null`로 작성해 주세요.
- 정의되지 않은 필드를 임의로 추가하지 마세요.

## Workspace 경로 규칙

- 모든 경로는 Workspace 루트 기준 상대 경로로 작성해 주세요.
- 운영체제 절대 경로를 작성하지 마세요.
- Workspace 루트 디렉터리 이름을 경로 앞에 포함하지 마세요.
- 경로 구분자는 `/`를 사용해 주세요.
- 같은 경로를 여러 번 작성하지 마세요.

경로 예시:

- `src/extension.ts`
- `src/features/example.ts`
- `src/shared/example-utils.ts`

위 경로는 JSON 작성 방식을 보여 주는 중립적인 예시일 뿐이며, 실제 Plan의 대상 경로를 강제하지 않습니다.

## 코드 노드 ID 규칙

정확한 파일이 확인된 경우:

`file:<workspace-relative-path>`

정확한 디렉터리가 확인된 경우:

`directory:<workspace-relative-path>`

파일 또는 디렉터리 후보를 정하기 어려운 경우:

`unresolved:<kebab-case-short-id>`

예시:

- `file:src/extension.ts`
- `directory:src/agent`
- `unresolved:profile-settings-file`

모든 target에는 `codeNodeId`를 작성해 주세요.

## Task 규칙

- `tasks`에는 최소 1개의 Task를 작성해 주세요.
- Task는 구현 순서대로 작성해 주세요.
- Task ID는 `task-1`, `task-2`, `task-3`처럼 1부터 순서대로 증가시켜 주세요.
- `order`는 배열에서의 Task 순서와 일치해야 합니다.
- 각 Task에는 목적과 수행 내용을 이해할 수 있는 제목과 설명을 작성해 주세요.

Task의 대상 배열은 다음 의미로 사용합니다.

- `directTargets`: 기존 파일이나 경로를 직접 수정하는 대상
- `createdTargets`: 새로 생성하는 파일이나 경로
- `deletedTargets`: 파일 삭제 또는 기존 코드·UI 블록 제거 대상
- `referenceTargets`: 계획 또는 구현을 위해 읽고 참고하는 대상
- `possibleImpactTargets`: 직접 변경 대상은 아니지만 영향을 받을 수 있는 대상

대상 배열의 값은 Workspace 상대 경로로 작성해 주세요.

경로를 정할 수 없는 unresolved 대상은 Task 대상 배열에 임의 경로로 작성하지 말고 `targetNodes`에서 `taskIds`로 Task와 연결해 주세요.

## relation 규칙

`relation`은 다음 값 중 하나를 사용해 주세요.

### direct

생성, 수정, 삭제 또는 내부 코드·UI 제거가 계획된 대상입니다.

### possible-impact

직접 변경 대상으로 확정되지는 않았지만 변경 결과의 영향을 받을 수 있는 대상입니다.

### reference

계획 또는 구현을 위해 읽고 참고하지만 직접 변경하지 않는 대상입니다.

하나의 경로에는 relation을 하나만 사용해 주세요.

여러 relation이 겹치면 다음 우선순위로 하나를 선택해 주세요.

`direct > possible-impact > reference`

## changes 규칙

`changes`에는 다음 값만 사용할 수 있습니다.

- `create`: 새 파일, 컴포넌트, 모듈 또는 데이터 구조 생성
- `modify`: 기존 코드, UI, 데이터, import, props, 스타일 또는 문구 변경
- `delete`: 파일 삭제 또는 기존 코드·UI 블록 제거

변경이 없는 `reference`와 `possible-impact` 대상은 `changes`를 `[]`로 작성해 주세요.

같은 파일에 수정과 내부 제거가 함께 계획되면 하나의 targetNode에 다음처럼 합쳐 주세요.

    {
      "relation": "direct",
      "changes": ["modify", "delete"]
    }

파일 전체를 삭제하는 경우에만 `isFileDeletion`을 `true`로 작성해 주세요.

파일 내부의 코드나 UI만 제거하는 경우:

- `changes`에 `"delete"`를 포함해 주세요.
- `isFileDeletion`은 `false`로 작성해 주세요.
- `note`에 파일 삭제가 아니라 내부 요소 제거임을 설명해 주세요.

## matchStatus 규칙

`matchStatus`는 작업의 확정도가 아니라 대상 경로의 연결 상태를 나타냅니다.

### resolved

정확한 파일 또는 디렉터리 경로를 확인한 상태입니다.

아직 존재하지 않는 생성 예정 파일도 생성 경로가 정확하면 `resolved`입니다.

### scoped

정확한 파일은 정하지 못했지만 디렉터리나 기능 범위까지 확인한 상태입니다.

### unresolved

파일 또는 디렉터리 후보를 안정적으로 정할 수 없는 상태입니다.

unresolved 대상은 다음 규칙을 따라 주세요.

- `path`는 `null`
- `codeNodeId`는 `unresolved:<kebab-case-short-id>`
- `originalTargetText`에는 사용자의 원래 대상 표현을 보존
- `note`에는 경로를 정하지 못한 이유를 작성

## isAdditionalCandidate 규칙

- 사용자가 정확한 경로를 직접 언급한 대상은 `false`로 작성해 주세요.
- 사용자가 경로를 언급하지 않았고 Workspace 분석을 통해 추가로 식별한 대상은 `true`로 작성해 주세요.
- unresolved 대상은 경로 후보가 아니므로 `false`로 작성해 주세요.

## 파일 목록과 targetNodes 연결 규칙

다음 목록에 작성한 모든 경로는 `targetNodes`에도 포함해야 합니다.

- `expectedModifiedFiles`
- `expectedCreatedFiles`
- `expectedDeletedOrRemovedTargets`
- `referenceFiles`

Task의 다음 배열에 작성한 경로도 `targetNodes`에 포함해야 합니다.

- `directTargets`
- `createdTargets`
- `deletedTargets`
- `referenceTargets`
- `possibleImpactTargets`

추가 규칙:

- `expectedModifiedFiles`의 대상에는 `"modify"` change가 있어야 합니다.
- `expectedCreatedFiles`의 대상에는 `"create"` change가 있어야 합니다.
- `expectedDeletedOrRemovedTargets`의 대상에는 `"delete"` change가 있어야 합니다.
- `referenceFiles`의 대상은 `relation: "reference"`이고 `changes: []`여야 합니다.
- 동일 경로가 여러 목록에 등장하더라도 `targetNodes`에는 하나로 합쳐 주세요.
- `taskIds`에는 해당 대상을 사용하는 모든 Task ID를 포함해 주세요.

## ChangePlan JSON 형식

    {
      "title": "작업 계획 제목",
      "summary": "전체 변경 의도와 구현 방향 요약",
      "tasks": [
        {
          "id": "task-1",
          "title": "Task 제목",
          "description": "Task에서 수행할 작업 설명",
          "order": 1,
          "directTargets": [],
          "createdTargets": [],
          "deletedTargets": [],
          "referenceTargets": [],
          "possibleImpactTargets": []
        }
      ],
      "expectedModifiedFiles": [
        {
          "path": "path/to/existing-file.ts",
          "codeNodeId": "file:path/to/existing-file.ts",
          "reason": "파일을 수정해야 하는 이유",
          "taskIds": ["task-1"]
        }
      ],
      "expectedCreatedFiles": [
        {
          "path": "path/to/new-file.ts",
          "codeNodeId": "file:path/to/new-file.ts",
          "reason": "파일을 생성해야 하는 이유",
          "taskIds": ["task-1"]
        }
      ],
      "expectedDeletedOrRemovedTargets": [
        {
          "path": "path/to/existing-file.ts",
          "codeNodeId": "file:path/to/existing-file.ts",
          "description": "삭제하거나 제거할 대상 설명",
          "isFileDeletion": false,
          "taskIds": ["task-1"]
        }
      ],
      "referenceFiles": [
        {
          "path": "path/to/reference-file.ts",
          "codeNodeId": "file:path/to/reference-file.ts",
          "reason": "파일을 참고해야 하는 이유",
          "taskIds": ["task-1"]
        }
      ],
      "targetNodes": [
        {
          "relation": "direct",
          "changes": ["modify"],
          "matchStatus": "resolved",
          "path": "path/to/existing-file.ts",
          "codeNodeId": "file:path/to/existing-file.ts",
          "taskIds": ["task-1"],
          "isAdditionalCandidate": true,
          "isFileDeletion": false,
          "originalTargetText": null,
          "note": null
        }
      ],
      "preImplementationChecks": [
        "실제 구현 전에 확인해야 할 내용"
      ],
      "postImplementationComparisonCriteria": [
        "구현 완료 후 승인한 Plan과 실제 결과를 비교할 기준"
      ]
    }

## 사용자 요청

{{USER_PROMPT}}
