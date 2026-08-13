/**
 * @file 익스텐션 호스트의 작업공간 컨텍스트 판독기와 순수 정책 검증기를 조합한다.
 * 최초 시작, 모든 재시작과 향후 그래프가 동일한 작업공간 루트 판정 경계를
 * 공유하도록 인자 없는 단일 표준 resolver를 제공한다.
 */
import {
	readVsCodeWorkspaceContext,
	type WorkspaceContextSnapshot,
} from './workspaceContext';
import { validateWorkspacePolicy } from './workspacePolicy';
import type { WorkspaceValidationResult } from './types';

/**
 * 호출 시점의 익스텐션 호스트 작업공간 컨텍스트를 새 스냅샷으로 읽는 함수다.
 *
 * @returns 현재 작업공간 상태만 담은 불변 컨텍스트 스냅샷이다.
 */
export type WorkspaceContextSnapshotReader = () => WorkspaceContextSnapshot;

/**
 * 작업공간 컨텍스트 스냅샷을 순수 정책 검증 결과로 변환하는 함수다.
 *
 * @param snapshot 익스텐션 호스트가 현재 호출에서 새로 읽은 작업공간 상태다.
 * @returns 검증된 루트 또는 경로 정보가 없는 안전한 정책 오류다.
 */
export type WorkspacePolicyValidator = (
	snapshot: WorkspaceContextSnapshot,
) => WorkspaceValidationResult;

/**
 * 최초 시작, 모든 재시작과 향후 그래프가 공유하는 작업공간 해석 함수다.
 *
 * @returns 현재 상태를 다시 읽고 검증한 작업공간 정책 결과다.
 */
export type WorkspaceResolver = () => WorkspaceValidationResult;

/** 작업공간 resolver를 구성하는 익스텐션 호스트 소유 의존성이다. */
export interface WorkspaceResolverDependencies {
	/** 호출마다 현재 작업공간 상태를 새 스냅샷으로 수집한다. */
	readonly readContext: WorkspaceContextSnapshotReader;

	/** 수집된 스냅샷에 고정된 작업공간 정책을 적용한다. */
	readonly validatePolicy: WorkspacePolicyValidator;
}

/**
 * 주입된 컨텍스트 판독기와 정책 검증기로 단일 표준 resolver를 만든다.
 * resolver는 이전 결과나 루트를 캐시하지 않고 호출할 때마다 새 컨텍스트를 검증한다.
 *
 * @param dependencies 익스텐션 호스트의 작업공간 판독 및 순수 정책 검증 함수다.
 * @returns 웹뷰 식별자나 루트 덮어쓰기 값을 받지 않는 작업공간 resolver다.
 */
export function createWorkspaceResolver(
	dependencies: WorkspaceResolverDependencies,
): WorkspaceResolver {
	const { readContext, validatePolicy } = dependencies;

	return function resolveWorkspace(): WorkspaceValidationResult {
		const snapshot = readContext();
		return validatePolicy(snapshot);
	};
}

/**
 * 익스텐션 호스트의 현재 작업공간 루트를 해석하는 단일 표준 진입점이다.
 * 최초 시작 전과 모든 재시작 전, 그리고 향후 그래프에서 동일하게 호출한다.
 * 성공 결과는 호스트 내부 실행 준비에만 사용하며 프로토콜 메시지로 노출하지 않는다.
 */
export const resolveCurrentWorkspace = createWorkspaceResolver({
	readContext: readVsCodeWorkspaceContext,
	validatePolicy: validateWorkspacePolicy,
});
