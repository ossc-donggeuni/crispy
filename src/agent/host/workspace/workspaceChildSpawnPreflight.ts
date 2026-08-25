/**
 * Host가 child process를 만들기 직전에 current assignment의 Workspace를 다시
 * 검증하고 이번 spawn에 사용할 fresh cwd를 반환하는 동기 경계다.
 *
 * `undefined`는 Workspace/Trust 또는 session ownership이 더 이상 유효하지 않아
 * child process를 만들면 안 된다는 뜻이다.
 */
export type WorkspaceChildSpawnCwdResolver = () => string | undefined;
