import * as vscode from 'vscode';
import type {
	FileAnalysisResultStatus,
	SymbolDisplayKind,
	SymbolMetadata,
} from '../model/fileAnalysis';
import type { ProjectNode } from '../model/projectNode';

/** constant supportedSymbolKinds
 *
 * - File Detail Box에 표시할 VS Code Document Symbol 종류를 한곳에서 관리한다.
 */
export const supportedSymbolKinds: ReadonlySet<vscode.SymbolKind> = new Set([
	vscode.SymbolKind.Function,
	vscode.SymbolKind.Class,
	vscode.SymbolKind.Method,
	vscode.SymbolKind.Constructor,
	vscode.SymbolKind.Interface,
	vscode.SymbolKind.Enum,
	vscode.SymbolKind.Struct,
	vscode.SymbolKind.Module,
]);

/** type DocumentSymbolAnalysisResult
 *
 * - Extension Host가 Webview에 반환할 파일 Symbol 분석 결과를 정의한다.
 */
export type DocumentSymbolAnalysisResult = {
	status: FileAnalysisResultStatus;
	symbolNodes: ProjectNode[];
	symbolMetadata: SymbolMetadata[];
	errorMessage?: string;
};

/** type NormalizedSymbols
 *
 * - 공통 ProjectNode Symbol과 별도 표시 메타데이터의 정규화 결과를 정의한다.
 */
export type NormalizedSymbols = {
	symbolNodes: ProjectNode[];
	symbolMetadata: SymbolMetadata[];
};

type NormalizableSymbol = {
	name: string;
	kind: vscode.SymbolKind;
	line: number;
	character: number;
	detail?: string;
};

const displayKindBySymbolKind = new Map<vscode.SymbolKind, SymbolDisplayKind>([
	[vscode.SymbolKind.Function, 'function'],
	[vscode.SymbolKind.Class, 'class'],
	[vscode.SymbolKind.Method, 'method'],
	[vscode.SymbolKind.Constructor, 'constructor'],
	[vscode.SymbolKind.Interface, 'interface'],
	[vscode.SymbolKind.Enum, 'enum'],
	[vscode.SymbolKind.Struct, 'struct'],
	[vscode.SymbolKind.Module, 'module'],
]);

/** function analyzeDocumentSymbols( workspaceFolder, fileNodeId, relativePath )
 *
 * - 요청 경로와 실제 Workspace 파일을 검증한다.
 * - 문서를 Editor에 표시하지 않고 Document Symbol Provider를 실행한다.
 * - Provider 결과를 ProjectNode와 SymbolMetadata 목록으로 정규화한다.
 *
 * @param workspaceFolder 분석 대상 파일이 속한 단일 Workspace Folder
 * @param fileNodeId 		file:<relativePath> 형식의 파일 노드 ID
 * @param relativePath 	Workspace 기준 파일 상대 경로
 * @returns 				지원 여부와 정규화된 Symbol 분석 결과
 */
export async function analyzeDocumentSymbols(
	workspaceFolder: vscode.WorkspaceFolder,
	fileNodeId: string,
	relativePath: string,
): Promise<DocumentSymbolAnalysisResult> {
	try {
		const fileUri = createValidatedFileUri(
			workspaceFolder,
			fileNodeId,
			relativePath,
		);
		// URI가 실제 일반 파일인지 확인하고 디렉터리와 Symbolic Link 요청을 거부한다.
		const stat = await vscode.workspace.fs.stat(fileUri);
		if (
			(stat.type & vscode.FileType.File) === 0
			|| (stat.type & vscode.FileType.Directory) !== 0
			|| (stat.type & vscode.FileType.SymbolicLink) !== 0
		) {
			throw new Error('The requested Workspace entry is not a regular file.');
		}

		// 문서를 메모리에만 로드하고 사용자의 현재 Editor는 변경하지 않는다.
		await vscode.workspace.openTextDocument(fileUri);
		const symbols = await vscode.commands.executeCommand<
			vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined
		>(
			'vscode.executeDocumentSymbolProvider',
			fileUri,
		);

		// undefined는 해당 파일을 처리할 Document Symbol Provider가 없음을 의미한다.
		if (symbols === undefined || symbols === null) {
			return {
				status: 'unsupported',
				symbolNodes: [],
				symbolMetadata: [],
			};
		}

		// 빈 배열은 Provider가 지원하지만 표시할 선언이 없는 정상 결과로 취급한다.
		if (symbols.length === 0) {
			return {
				status: 'ready',
				symbolNodes: [],
				symbolMetadata: [],
			};
		}

		// Provider가 반환한 결과 형태에 맞는 정규화 함수를 선택한다.
		const documentSymbols = symbols.filter(isDocumentSymbol);
		const normalized = documentSymbols.length > 0
			? normalizeDocumentSymbols(documentSymbols, fileNodeId, relativePath)
			: normalizeSymbolInformation(
				symbols.filter(isSymbolInformation),
				fileUri,
				fileNodeId,
				relativePath,
			);

		return {
			status: 'ready',
			...normalized,
		};
	} catch (error) {
		// 경로 검증과 VS Code API 오류를 실패 상태로 변환해 Webview 전체 실패를 막는다.
		return {
			status: 'failed',
			symbolNodes: [],
			symbolMetadata: [],
			errorMessage: getErrorMessage(error),
		};
	}
}

/** function createValidatedFileUri( workspaceFolder, fileNodeId, relativePath )
 *
 * - 요청 ID와 상대 경로를 먼저 검증한다.
 * - vscode.Uri.joinPath로 Workspace 내부 파일 URI를 생성한다.
 * - URI의 scheme, authority, path가 Workspace 경계를 벗어나지 않는지 확인한다.
 *
 * @param workspaceFolder 파일이 속해야 하는 Workspace Folder
 * @param fileNodeId 		요청한 파일 노드 ID
 * @param relativePath 	요청한 Workspace 상대 경로
 * @returns 				검증된 파일 URI
 */
export function createValidatedFileUri(
	workspaceFolder: vscode.WorkspaceFolder,
	fileNodeId: string,
	relativePath: string,
): vscode.Uri {
	const segments = validateFileAnalysisPath(fileNodeId, relativePath);
	const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, ...segments);
	const workspacePath = workspaceFolder.uri.path.endsWith('/')
		? workspaceFolder.uri.path
		: `${workspaceFolder.uri.path}/`;

	if (
		fileUri.scheme !== workspaceFolder.uri.scheme
		|| fileUri.authority !== workspaceFolder.uri.authority
		|| !fileUri.path.startsWith(workspacePath)
	) {
		throw new Error('The requested file is outside the active Workspace.');
	}

	return fileUri;
}

/** function validateFileAnalysisPath( fileNodeId, relativePath )
 *
 * - 절대 경로, 역슬래시, 빈 경로와 경로 탈출 세그먼트를 거부한다.
 * - fileNodeId가 file:<relativePath> 규칙과 정확히 일치하는지 검사한다.
 *
 * @param fileNodeId 	요청한 파일 노드 ID
 * @param relativePath 요청한 Workspace 상대 경로
 * @returns 			URI 결합에 사용할 안전한 경로 세그먼트
 */
export function validateFileAnalysisPath(
	fileNodeId: string,
	relativePath: string,
): string[] {
	if (
		relativePath.trim().length === 0
		|| relativePath.startsWith('/')
		|| relativePath.startsWith('\\')
		|| /^[a-zA-Z]:[\\/]/.test(relativePath)
		|| relativePath.includes('\\')
	) {
		throw new Error('The requested file path must be Workspace-relative.');
	}

	const segments = relativePath.split('/');
	if (
		segments.some(
			(segment) =>
				segment.length === 0
				|| segment === '.'
				|| segment === '..',
		)
	) {
		throw new Error('The requested file path contains invalid segments.');
	}

	if (fileNodeId !== `file:${relativePath}`) {
		throw new Error('The file node ID does not match the requested path.');
	}

	return segments;
}

/** function normalizeDocumentSymbols( symbols, fileNodeId, relativePath )
 *
 * - DocumentSymbol 최상위 배열에서 지원하는 종류만 선택한다.
 * - children은 재귀 탐색하지 않고 선택 범위의 시작 위치를 사용한다.
 * - 공통 Symbol 정규화 로직에 전달한다.
 *
 * @param symbols 		Provider가 반환한 최상위 DocumentSymbol 목록
 * @param fileNodeId 	Symbol의 부모가 될 파일 노드 ID
 * @param relativePath Workspace 기준 파일 상대 경로
 * @returns 			정렬 및 중복 제거된 Symbol 노드와 메타데이터
 */
export function normalizeDocumentSymbols(
	symbols: readonly vscode.DocumentSymbol[],
	fileNodeId: string,
	relativePath: string,
): NormalizedSymbols {
	return normalizeSymbols(
		symbols
			.filter((symbol) => supportedSymbolKinds.has(symbol.kind))
			.map((symbol) => ({
				name: symbol.name,
				kind: symbol.kind,
				line: symbol.selectionRange.start.line,
				character: symbol.selectionRange.start.character,
				...(symbol.detail.trim() ? { detail: symbol.detail.trim() } : {}),
			})),
		fileNodeId,
		relativePath,
	);
}

/** function normalizeSymbolInformation( symbols, fileUri, fileNodeId, relativePath )
 *
 * - 현재 파일 URI에 속하며 지원되는 SymbolInformation만 선택한다.
 * - containerName이 비어 있는 항목을 우선해 최상위 선언을 추정한다.
 * - 계층 정보가 없으면 현재 파일의 일치 항목을 최선의 결과로 사용한다.
 *
 * @param symbols 		Provider가 반환한 SymbolInformation 목록
 * @param fileUri 		분석 중인 실제 파일 URI
 * @param fileNodeId 	Symbol의 부모가 될 파일 노드 ID
 * @param relativePath Workspace 기준 파일 상대 경로
 * @returns 			정렬 및 중복 제거된 Symbol 노드와 메타데이터
 */
export function normalizeSymbolInformation(
	symbols: readonly vscode.SymbolInformation[],
	fileUri: vscode.Uri,
	fileNodeId: string,
	relativePath: string,
): NormalizedSymbols {
	const matchingSymbols = symbols.filter(
		(symbol) =>
			symbol.location.uri.toString() === fileUri.toString()
			&& supportedSymbolKinds.has(symbol.kind),
	);
	const symbolsWithoutContainer = matchingSymbols.filter(
		(symbol) => !symbol.containerName.trim(),
	);
	const topLevelSymbols = symbolsWithoutContainer.length > 0
		? symbolsWithoutContainer
		: matchingSymbols;

	return normalizeSymbols(
		topLevelSymbols.map((symbol) => ({
			name: symbol.name,
			kind: symbol.kind,
			line: symbol.location.range.start.line,
			character: symbol.location.range.start.character,
			...(symbol.containerName.trim()
				? { detail: symbol.containerName.trim() }
				: {}),
		})),
		fileNodeId,
		relativePath,
	);
}

/** function normalizeSymbols( symbols, fileNodeId, relativePath )
 *
 * - Symbol을 시작 줄, 문자 위치, 이름 순서로 정렬한다.
 * - 같은 이름과 시작 줄의 중복 항목을 하나만 유지한다.
 * - 공통 ProjectNode와 별도 SymbolMetadata를 함께 생성한다.
 *
 * @param symbols 		공통 형태로 변환된 Symbol 입력
 * @param fileNodeId 	Symbol의 부모가 될 파일 노드 ID
 * @param relativePath Workspace 기준 파일 상대 경로
 * @returns 			정규화된 Symbol 노드와 메타데이터
 */
function normalizeSymbols(
	symbols: readonly NormalizableSymbol[],
	fileNodeId: string,
	relativePath: string,
): NormalizedSymbols {
	const sortedSymbols = [...symbols].sort((left, right) => (
		left.line - right.line
		|| left.character - right.character
		|| left.name.localeCompare(right.name)
	));
	const seenSymbols = new Set<string>();
	const symbolNodes: ProjectNode[] = [];
	const symbolMetadata: SymbolMetadata[] = [];

	for (const symbol of sortedSymbols) {
		const deduplicationKey = `${symbol.name}\u0000${symbol.line}`;
		const displayKind = displayKindBySymbolKind.get(symbol.kind);
		if (seenSymbols.has(deduplicationKey) || !displayKind) {
			continue;
		}

		seenSymbols.add(deduplicationKey);
		const startLine = symbol.line + 1;
		const nodeId = createSymbolNodeId(relativePath, symbol.name, startLine);
		symbolNodes.push({
			id: nodeId,
			type: 'symbol',
			name: symbol.name,
			relativePath,
			parentId: fileNodeId,
			childrenIds: [],
		});
		symbolMetadata.push({
			nodeId,
			kind: displayKind,
			startLine,
			...(symbol.detail ? { detail: symbol.detail } : {}),
		});
	}

	return {
		symbolNodes,
		symbolMetadata,
	};
}

/** function createSymbolNodeId( relativePath, symbolName, startLine )
 *
 * - 기존 function:<relativePath>:<symbolName>:<startLine> ID 계약을 유지한다.
 * - 구분자와 충돌하는 콜론 또는 퍼센트가 있는 Symbol 이름은 인코딩한다.
 *
 * @param relativePath Symbol이 선언된 파일 상대 경로
 * @param symbolName 	Symbol 표시 이름
 * @param startLine 	1부터 시작하는 선언 줄 번호
 * @returns 			안전하게 생성한 Symbol 노드 ID
 */
function createSymbolNodeId(
	relativePath: string,
	symbolName: string,
	startLine: number,
): string {
	const safeName = /[:%]/.test(symbolName)
		? encodeURIComponent(symbolName)
		: symbolName;
	return `function:${relativePath}:${safeName}:${startLine}`;
}

/** function isDocumentSymbol( symbol )
 *
 * - Provider 결과가 selectionRange와 children을 가진 DocumentSymbol인지 검사한다.
 *
 * @param symbol 검사할 VS Code Symbol 결과
 * @returns 		DocumentSymbol 여부
 */
function isDocumentSymbol(
	symbol: vscode.DocumentSymbol | vscode.SymbolInformation,
): symbol is vscode.DocumentSymbol {
	return 'selectionRange' in symbol && 'children' in symbol;
}

/** function isSymbolInformation( symbol )
 *
 * - Provider 결과가 location을 가진 SymbolInformation인지 검사한다.
 *
 * @param symbol 검사할 VS Code Symbol 결과
 * @returns 		SymbolInformation 여부
 */
function isSymbolInformation(
	symbol: vscode.DocumentSymbol | vscode.SymbolInformation,
): symbol is vscode.SymbolInformation {
	return 'location' in symbol;
}

/** function getErrorMessage( error )
 *
 * - 알 수 없는 오류 값을 분석 결과에 포함할 문자열로 변환한다.
 *
 * @param error 변환할 오류 값
 * @returns 	오류 메시지 문자열
 */
function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
