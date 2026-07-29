import type {
	FileAnalysisResult,
	FileAnalysisState,
} from '../model/fileAnalysis';

export type FileAnalysisRequestIdFactory = () => string;

let requestSequence = 0;

export function createFileAnalysisRequestId(): string {
	requestSequence += 1;
	return `file-analysis-${Date.now().toString(36)}-${requestSequence.toString(36)}`;
}

export class FileAnalysisStateStore {
	private readonly states = new Map<string, FileAnalysisState>();

	public constructor(
		private readonly createRequestId: FileAnalysisRequestIdFactory =
			createFileAnalysisRequestId,
	) {}

	public get all(): ReadonlyMap<string, FileAnalysisState> {
		return this.states;
	}

	public get(fileNodeId: string): FileAnalysisState | undefined {
		return this.states.get(fileNodeId);
	}

	public beginOnOpen(fileNodeId: string): string | undefined {
		if (this.states.has(fileNodeId)) {
			return undefined;
		}

		return this.begin(fileNodeId);
	}

	public retry(fileNodeId: string): string | undefined {
		if (this.states.get(fileNodeId)?.status !== 'failed') {
			return undefined;
		}

		return this.begin(fileNodeId);
	}

	public markUnsupported(fileNodeId: string): void {
		this.states.set(fileNodeId, {
			status: 'unsupported',
		});
	}

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

	private begin(fileNodeId: string): string {
		const requestId = this.createRequestId();
		this.states.set(fileNodeId, {
			status: 'loading',
			requestId,
		});
		return requestId;
	}
}
