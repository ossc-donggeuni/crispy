import type { ProjectNode } from './projectNode';

export type FileAnalysisStatus =
	| 'unsupported'
	| 'loading'
	| 'ready'
	| 'failed';

export type FileAnalysisResultStatus = Exclude<FileAnalysisStatus, 'loading'>;

export type SymbolDisplayKind =
	| 'function'
	| 'class'
	| 'method'
	| 'constructor'
	| 'interface'
	| 'enum'
	| 'struct'
	| 'module';

export type SymbolMetadata = {
	nodeId: string;
	kind: SymbolDisplayKind;
	startLine: number;
	detail?: string;
};

export type FileAnalysisState = {
	status: FileAnalysisStatus;
	requestId?: string;
	errorMessage?: string;
};

export type FileAnalysisResult = {
	requestId: string;
	fileNodeId: string;
	status: FileAnalysisResultStatus;
	symbolNodes: ProjectNode[];
	symbolMetadata: SymbolMetadata[];
	errorMessage?: string;
};
