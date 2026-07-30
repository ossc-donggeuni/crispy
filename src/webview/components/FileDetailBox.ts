import type { ProjectNode } from '../../model/projectNode';
import {
	applyNodeState,
	createElement,
	type GraphComponentContext,
} from './componentTypes';
import { createSymbolBlock } from './SymbolBlock';

/** function createFileDetailBox( file, context )
 *
 * - 파일 이름, 상대 경로, 닫기 버튼과 Symbol 목록을 표시한다.
 * - 파일 분석 상태에 따라 Loading, Ready, Unsupported, Failed UI를 선택한다.
 * - Box 드래그, 파일 선택, 분석 Retry 이벤트를 GraphView에 연결한다.
 *
 * @param file 	표시할 File 노드
 * @param context 그래프 컴포넌트 공통 컨텍스트
 * @returns 		렌더링된 File Detail Box 요소
 */
export function createFileDetailBox(
	file: ProjectNode,
	context: GraphComponentContext,
): HTMLElement {
	const box = createElement('section', 'graph-box file-detail-box');
	box.dataset.boxId = file.id;
	box.dataset.nodeId = file.id;
	applyNodeState(box, file.id, context);

	const header = createElement('header', 'box-header box-drag-handle');
	header.dataset.dragHandle = 'true';
	header.addEventListener('pointerdown', context.onBoxPointerDown);

	const heading = createElement('div', 'box-heading');
	const eyebrow = createElement('span', 'box-eyebrow', 'FILE DETAIL');
	const title = createElement('h2', 'box-title', file.name);
	const path = createElement('span', 'box-path', file.relativePath ?? file.name);
	heading.append(eyebrow, title, path);

	const collapseButton = createElement('button', 'box-collapse', 'Close');
	collapseButton.type = 'button';
	collapseButton.title = `Close ${file.name} details`;
	collapseButton.addEventListener('click', (event) => {
		event.stopPropagation();
		context.onToggleFile(file.id);
	});
	header.append(heading, collapseButton);

	const body = createElement('div', 'box-body symbol-list');
	const symbols = file.childrenIds
		.map((childId) => context.nodesById.get(childId))
		.filter((node): node is ProjectNode => node?.type === 'symbol');
	const analysisState = context.fileAnalysisStates.get(file.id);

	// 파일별 최신 분석 상태에 맞는 본문을 표시한다.
	switch (analysisState?.status) {
		case 'loading':
			body.append(
				createElement(
					'p',
					'box-empty analysis-loading',
					'Analyzing file structure...',
				),
			);
			break;
		case 'unsupported':
			body.append(
				createElement(
					'p',
					'box-empty',
					'Internal analysis is not supported for this file.',
				),
			);
			break;
		case 'failed':
			// 긴 원본 오류는 기본 본문 대신 Hover title로만 제공한다.
			body.title = analysisState.errorMessage ?? '';
			body.append(
				createElement('p', 'box-empty', 'File analysis failed.'),
				createRetryButton(file, context),
			);
			break;
		case 'ready':
			appendReadySymbols(body, symbols, context);
			break;
		default:
			// Mock 데이터처럼 분석 상태 없이 전달된 Symbol도 기존 화면과 호환한다.
			if (symbols.length > 0) {
				appendSymbolBlocks(body, symbols, context);
			} else {
				body.append(
					createElement('p', 'box-empty', 'No function blocks available.'),
				);
			}
	}

	box.append(header, body);
	box.addEventListener('click', (event) => {
		// Close와 Retry 버튼이 아닌 Box 빈 영역에서 파일을 선택한다.
		const target = event.target as HTMLElement;
		if (!target.closest('button')) {
			context.onSelect(file.id);
		}
	});
	return box;
}

/** function appendReadySymbols( body, symbols, context )
 *
 * - 분석이 완료된 파일의 Symbol 목록 또는 정상 빈 결과 문구를 추가한다.
 *
 * @param body 	Symbol 목록을 추가할 File Detail 본문
 * @param symbols 선언 순서대로 정렬된 Symbol 노드 목록
 * @param context 그래프 컴포넌트 공통 컨텍스트
 * @returns 		반환값 없음
 */
function appendReadySymbols(
	body: HTMLElement,
	symbols: readonly ProjectNode[],
	context: GraphComponentContext,
): void {
	if (symbols.length === 0) {
		body.append(
			createElement(
				'p',
				'box-empty',
				'No supported top-level symbols found.',
			),
		);
		return;
	}

	appendSymbolBlocks(body, symbols, context);
}

/** function appendSymbolBlocks( body, symbols, context )
 *
 * - 전달된 Symbol 노드를 현재 순서대로 Symbol Block으로 변환해 추가한다.
 *
 * @param body 	Symbol Block을 추가할 File Detail 본문
 * @param symbols 표시할 Symbol 노드 목록
 * @param context 그래프 컴포넌트 공통 컨텍스트
 * @returns 		반환값 없음
 */
function appendSymbolBlocks(
	body: HTMLElement,
	symbols: readonly ProjectNode[],
	context: GraphComponentContext,
): void {
	for (const symbol of symbols) {
		body.append(createSymbolBlock(symbol, context));
	}
}

/** function createRetryButton( file, context )
 *
 * - failed 파일 분석을 다시 요청하는 Retry 버튼을 만든다.
 * - Click이 파일 선택이나 Box 드래그로 전파되지 않게 한다.
 *
 * @param file 	다시 분석할 File 노드
 * @param context 그래프 컴포넌트 공통 컨텍스트
 * @returns 		렌더링된 Retry 버튼
 */
function createRetryButton(
	file: ProjectNode,
	context: GraphComponentContext,
): HTMLButtonElement {
	const retryButton = createElement('button', 'analysis-retry', 'Retry');
	retryButton.type = 'button';
	retryButton.title = `Retry analysis for ${file.name}`;
	retryButton.addEventListener('click', (event) => {
		event.preventDefault();
		event.stopPropagation();
		context.onRetryFileAnalysis(file.id);
	});
	return retryButton;
}
