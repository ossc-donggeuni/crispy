import type {
	FileAnalysisResult,
	FileAnalysisState,
} from '../model/fileAnalysis';

export type FileAnalysisRequestIdFactory = () => string;

let requestSequence = 0;

/** function createFileAnalysisRequestId()
 *
 * - 현재 시각과 증가 순번을 결합해 Webview 세션에서 사용할 요청 ID를 만든다.
 *
 * @returns 새 파일 분석 requestId
 */
export function createFileAnalysisRequestId(): string {
	requestSequence += 1;
	return `file-analysis-${Date.now().toString(36)}-${requestSequence.toString(36)}`;
}

/** class FileAnalysisStateStore
 *
 * - 파일별 Document Symbol 분석 상태와 최신 requestId를 저장한다.
 * - 최초 펼침, 실패 후 재시도, 분석 결과 적용의 상태 전이를 제한한다.
 * - 오래된 requestId 결과를 거부해 요청 경쟁 상태를 방지한다.
 */
export class FileAnalysisStateStore {
	private readonly states = new Map<string, FileAnalysisState>(); // 파일 노드 ID별 최신 분석 상태

	/** constructor ( createRequestId )
	 *
	 * - 분석 요청 ID 생성기를 저장한다.
	 * - 테스트에서는 결정적인 ID 생성기를 주입할 수 있다.
	 *
	 * @param createRequestId 새 분석 requestId를 생성할 함수
	 */
	public constructor(
		private readonly createRequestId: FileAnalysisRequestIdFactory =
		createFileAnalysisRequestId,
	) {}

	/** getter all
	 *
	 * - File Detail Box가 참조할 전체 파일 분석 상태를 읽기 전용으로 반환한다.
	 *
	 * @returns 파일 노드 ID별 분석 상태 Map
	 */
	public get all(): ReadonlyMap<string, FileAnalysisState> {
		return this.states;
	}

	/** function get( fileNodeId )
	 *
	 * - 하나의 파일에 저장된 최신 분석 상태를 조회한다.
	 *
	 * @param fileNodeId 조회할 파일 노드 ID
	 * @returns 			파일 분석 상태 또는 undefined
	 */
	public get(fileNodeId: string): FileAnalysisState | undefined {
		return this.states.get(fileNodeId);
	}

	/** function beginOnOpen( fileNodeId )
	 *
	 * - 분석 이력이 없는 파일의 최초 펼침에서만 loading 상태를 시작한다.
	 * - 이미 loading, ready, unsupported, failed 상태가 있으면 중복 요청하지 않는다.
	 *
	 * @param fileNodeId 펼친 파일 노드 ID
	 * @returns 			새 requestId 또는 요청하지 않을 경우 undefined
	 */
	public beginOnOpen(fileNodeId: string): string | undefined {
		if (this.states.has(fileNodeId)) {
			return undefined;
		}

		return this.begin(fileNodeId);
	}

	/** function retry( fileNodeId )
	 *
	 * - failed 상태인 파일만 새 requestId로 다시 loading 상태를 시작한다.
	 *
	 * @param fileNodeId 다시 분석할 파일 노드 ID
	 * @returns 			새 requestId 또는 재시도할 수 없으면 undefined
	 */
	public retry(fileNodeId: string): string | undefined {
		if (this.states.get(fileNodeId)?.status !== 'failed') {
			return undefined;
		}

		return this.begin(fileNodeId);
	}

	/** function markUnsupported( fileNodeId )
	 *
	 * - 상대 경로가 없는 파일을 분석 미지원 상태로 기록한다.
	 *
	 * @param fileNodeId 미지원으로 표시할 파일 노드 ID
	 * @returns 			반환값 없음
	 */
	public markUnsupported(fileNodeId: string): void {
		this.states.set(fileNodeId, {
			status: 'unsupported',
		});
	}

	/** function applyResult( result )
	 *
	 * - loading 상태의 최신 requestId와 일치하는 결과만 적용한다.
	 * - 오래된 결과는 상태를 변경하지 않고 false를 반환한다.
	 *
	 * @param result Extension에서 수신한 파일 분석 결과
	 * @returns 		결과 적용 여부
	 */
	public applyResult(result: FileAnalysisResult): boolean {
		const current = this.states.get(result.fileNodeId);
		if (
			current?.status !== 'loading'
			|| current.requestId !== result.requestId
		) {
			return false;
		}

		this.states.set(result.fileNodeId, {
			status: result.status,
			requestId: result.requestId,
			...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
		});
		return true;
	}

	/** function begin( fileNodeId )
	 *
	 * - 새 requestId를 만들고 파일을 loading 상태로 저장한다.
	 *
	 * @param fileNodeId 분석을 시작할 파일 노드 ID
	 * @returns 			생성한 requestId
	 */
	private begin(fileNodeId: string): string {
		const requestId = this.createRequestId();
		this.states.set(fileNodeId, {
			status: 'loading',
			requestId,
		});
		return requestId;
	}
}
