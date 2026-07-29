import * as vscode from 'vscode';
import type {
	FileAnalysisResultStatus,
	SymbolDisplayKind,
	SymbolMetadata,
} from '../model/fileAnalysis';
import type { ProjectNode } from '../model/projectNode';

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

export type DocumentSymbolAnalysisResult = {
	status: FileAnalysisResultStatus;
	symbolNodes: ProjectNode[];
	symbolMetadata: SymbolMetadata[];
	errorMessage?: string;
};

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
		const stat = await vscode.workspace.fs.stat(fileUri);
		if (
			(stat.type & vscode.FileType.File) === 0
			|| (stat.type & vscode.FileType.Directory) !== 0
			|| (stat.type & vscode.FileType.SymbolicLink) !== 0
		) {
			throw new Error('The requested Workspace entry is not a regular file.');
		}

		await vscode.workspace.openTextDocument(fileUri);
		const symbols = await vscode.commands.executeCommand<
			vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined
		>(
			'vscode.executeDocumentSymbolProvider',
			fileUri,
		);

		if (symbols === undefined || symbols === null) {
			return {
				status: 'unsupported',
				symbolNodes: [],
				symbolMetadata: [],
			};
		}

		if (symbols.length === 0) {
			return {
				status: 'ready',
				symbolNodes: [],
				symbolMetadata: [],
			};
		}

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
		return {
			status: 'failed',
			symbolNodes: [],
			symbolMetadata: [],
			errorMessage: getErrorMessage(error),
		};
	}
}

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

function isDocumentSymbol(
	symbol: vscode.DocumentSymbol | vscode.SymbolInformation,
): symbol is vscode.DocumentSymbol {
	return 'selectionRange' in symbol && 'children' in symbol;
}

function isSymbolInformation(
	symbol: vscode.DocumentSymbol | vscode.SymbolInformation,
): symbol is vscode.SymbolInformation {
	return 'location' in symbol;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
