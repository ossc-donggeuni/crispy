import type { ProjectNode } from './projectNode';

/** type FileAnalysisStatus
 *
 * - 파일별 Document Symbol 분석의 전체 상태를 정의한다.
 */
export type FileAnalysisStatus =
	| 'unsupported'
	| 'loading'
	| 'ready'
	| 'failed';

/** type FileAnalysisResultStatus
 *
 * - Extension이 Webview에 반환할 수 있는 완료 상태를 정의한다.
 */
export type FileAnalysisResultStatus = Exclude<FileAnalysisStatus, 'loading'>;

/** type SymbolDisplayKind
 *
 * - File Detail Box가 표시하는 최상위 선언 종류를 정의한다.
 */
export type SymbolDisplayKind =
	| 'function'
	| 'class'
	| 'method'
	| 'constructor'
	| 'interface'
	| 'enum'
	| 'struct'
	| 'module';

/** type SymbolMetadata
 *
 * - 공통 ProjectNode와 분리된 Symbol 종류, 줄 번호, 상세 정보를 정의한다.
 */
export type SymbolMetadata = {
	nodeId: string;
	kind: SymbolDisplayKind;
	startLine: number;
	detail?: string;
};

/** type FileAnalysisState
 *
 * - 파일별 최신 분석 상태와 requestId 및 오류 메시지를 저장한다.
 */
export type FileAnalysisState = {
	status: FileAnalysisStatus;
	requestId?: string;
	errorMessage?: string;
};

/** type FileAnalysisResult
 *
 * - GraphView에 부분 반영할 파일 분석 결과를 정의한다.
 */
export type FileAnalysisResult = {
	requestId: string;
	fileNodeId: string;
	status: FileAnalysisResultStatus;
	symbolNodes: ProjectNode[];
	symbolMetadata: SymbolMetadata[];
	errorMessage?: string;
};
