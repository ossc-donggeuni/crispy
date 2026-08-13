# `src/webview/`

하나의 VS Code `WebviewPanel` 안에 Graph 영역과 Agent Chat 영역을 표시한다.

Graph와 Agent Chat은 각각 별도의 VS Code Panel이 아니며, 하나의 Webview 내부에서 CSS Grid로 배치된다.

## 구조

```text
src/webview/
├── panel/
├── README.md
├── webview.ts
└── webview.css
```

### `webview.ts`

> Webview 를 사용하기 위해 관련 요소들을 초기화하는 진입점입니다.

- VS Code Webview API 단일 획득
- 필요한 DOM 요소 조회
- 저장된 Layout 상태 복원
- Dock과 Resize 기능 초기화
- 로드 후 ready 메시지 전송

### `panel/`

> Agent Chat Panel의 Layout 조정 및 상태 관리를 담당합니다.

- `left`, `right`, `top`, `bottom` Dock 이동 및 Preview 처리
- Graph와 Agent Chat 사이의 가로·세로 Resize 처리
- 세부 구조와 동작은 `panel/README.md` 참고
