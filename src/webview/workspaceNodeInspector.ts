import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';
import {
	GRAPH_CAMERA_IGNORE_ATTRIBUTE,
	type GraphCamera,
} from './graph/graphCamera';
import { getGraphLayoutSourceId } from './graph/graphLayout';
import type { GraphVisibleArea } from './graph/graphVisibleArea';
import type {
	WorkspaceMutableNodeKind,
	WorkspaceNodeDetails,
	WorkspaceNodeDetailsResultMessage,
	WorkspaceNodeMutationResultMessage,
	WorkspaceNodeRequestMessage,
} from '../messages';
import type { WorkspacePersistentState } from '../workspace/workspaceMetadata';

export interface WorkspaceNodeInspector {
	handleDetailsResult(message: WorkspaceNodeDetailsResultMessage): void;
	handleMutationResult(message: WorkspaceNodeMutationResultMessage): void;
	refreshPosition(): void;
	dispose(): void;
}

export interface WorkspaceNodeInspectorInteractions {
	getWorkspaceRevision(): number;
	getWorkspaceState(): WorkspacePersistentState;
	postRequest(message: WorkspaceNodeRequestMessage): void;
	resolveVisibleGraphArea(viewport: HTMLElement): GraphVisibleArea;
}

interface FocusedWorkspaceNode {
	readonly nodeId: string;
	readonly kind: WorkspaceMutableNodeKind;
	element: HTMLElement;
}

const INSPECTOR_INSET = 12;
const INSPECTOR_GAP = 12;

/** Inspector의 document 전역 닫기 입력을 capture 단계에서 관리한다. */
export function initializeWorkspaceNodeInspectorDismissal(
	ownerDocument: Document,
	getInspector: () => HTMLElement | undefined,
	close: () => void,
): () => void {
	const handleKeyDown = (event: KeyboardEvent): void => {
		if (event.key !== 'Escape' || !getInspector()) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		close();
	};
	const handleDocumentPointerDown = (event: PointerEvent): void => {
		const inspector = getInspector();

		if (
			!inspector
			|| event.button !== 0
			|| event.composedPath().includes(inspector)
		) {
			return;
		}
		close();
	};

	ownerDocument.addEventListener('keydown', handleKeyDown, true);
	ownerDocument.addEventListener('pointerdown', handleDocumentPointerDown, true);

	return () => {
		ownerDocument.removeEventListener('keydown', handleKeyDown, true);
		ownerDocument.removeEventListener('pointerdown', handleDocumentPointerDown, true);
	};
}

/** Graph DOM의 실제 source 표현에만 event delegation을 적용하는 Inspector다. */
export function initializeWorkspaceNodeInspector(
	graphArea: HTMLElement,
	viewport: HTMLElement,
	overlayLayer: HTMLElement,
	camera: Pick<GraphCamera, 'viewportToWorld' | 'focusOn'>,
	monacoWorkerUri: string,
	interactions: WorkspaceNodeInspectorInteractions,
): WorkspaceNodeInspector {
	const ownerDocument = graphArea.ownerDocument;
	let focused: FocusedWorkspaceNode | undefined;
	let inspector: HTMLElement | undefined;
	let details: WorkspaceNodeDetails | undefined;
	let editor:
		| Monaco.editor.IStandaloneCodeEditor
		| Monaco.editor.IStandaloneDiffEditor
		| undefined;
	let models: Monaco.editor.ITextModel[] = [];
	let monacoApi: typeof Monaco | undefined;
	let previewGeneration = 0;
	let requestId = 0;
	let pendingDetailsRequestId: number | undefined;
	let pendingMutationRequestId: number | undefined;
	let disposed = false;
	const ThemeMutationObserver = ownerDocument.defaultView?.MutationObserver;
	const themeObserver = ThemeMutationObserver
		? new ThemeMutationObserver(() => {
			monacoApi?.editor.setTheme(resolveMonacoTheme(ownerDocument.body));
		})
		: undefined;

	themeObserver?.observe(ownerDocument.body, {
		attributes: true,
		attributeFilter: ['class', 'data-vscode-theme-kind'],
	});

	(globalThis as typeof globalThis & {
		MonacoEnvironment?: { getWorker(): Worker };
	}).MonacoEnvironment = {
		getWorker: () => new Worker(monacoWorkerUri),
	};

	const nextRequestId = (): number => {
		requestId = requestId < Number.MAX_SAFE_INTEGER ? requestId + 1 : 1;
		return requestId;
	};
	const clearEditor = (): void => {
		previewGeneration += 1;
		editor?.dispose();
		for (const model of models) {
			model.dispose();
		}
		editor = undefined;
		models = [];
	};
	const clearFocusedStyle = (): void => {
		focused?.element.classList.remove('is-workspace-node-focused');
	};
	const close = (): void => {
		clearFocusedStyle();
		focused = undefined;
		details = undefined;
		pendingDetailsRequestId = undefined;
		pendingMutationRequestId = undefined;
		clearEditor();
		inspector?.remove();
		inspector = undefined;
	};
	const refreshPosition = (): void => {
		if (!focused || !inspector) {
			return;
		}
		if (!focused.element.isConnected) {
			const element = findWorkspaceNodeElement(
				graphArea,
				focused.nodeId,
				focused.kind,
			);

			if (!element) {
				close();
				return;
			}
			focused.element = element;
			element.classList.add('is-workspace-node-focused');
		}
		const viewportBounds = viewport.getBoundingClientRect();
		const nodeBounds = focused.element.getBoundingClientRect();
		const visible = interactions.resolveVisibleGraphArea(viewport);
		const left = visible.left + INSPECTOR_INSET;
		const height = Math.max(
			0,
			Math.min(
				details?.kind === 'file' ? 520 : details?.kind === 'folder' ? 360 : 220,
				visible.height - INSPECTOR_INSET * 2,
			),
		);
		const desiredTop = nodeBounds.bottom - viewportBounds.top + INSPECTOR_GAP;
		const top = clamp(
			desiredTop,
			visible.top + INSPECTOR_INSET,
			Math.max(
				visible.top + INSPECTOR_INSET,
				visible.bottom - INSPECTOR_INSET - height,
			),
		);
		const width = Math.max(0, visible.width - INSPECTOR_INSET * 2);

		inspector.style.left = `${left}px`;
		inspector.style.top = `${top}px`;
		inspector.style.width = `${width}px`;
		inspector.style.height = `${height}px`;
		inspector.style.maxHeight = `${height}px`;
		editor?.layout();
	};
	const focusNode = (target: FocusedWorkspaceNode): void => {
		clearFocusedStyle();
		focused = target;
		target.element.classList.add('is-workspace-node-focused');
		target.element.tabIndex = -1;
		target.element.focus({ preventScroll: true });
		const viewportBounds = viewport.getBoundingClientRect();
		const nodeBounds = target.element.getBoundingClientRect();
		const visible = interactions.resolveVisibleGraphArea(viewport);
		const center = camera.viewportToWorld({
			x: nodeBounds.left - viewportBounds.left + nodeBounds.width / 2,
			y: nodeBounds.top - viewportBounds.top + nodeBounds.height / 2
				+ Math.min(200, visible.height / 4),
		});

		camera.focusOn(center);
	};
	const requestDetails = (): void => {
		if (!focused) {
			return;
		}
		pendingDetailsRequestId = nextRequestId();
		interactions.postRequest({
			type: 'workspace.nodeDetails.request',
			requestId: pendingDetailsRequestId,
			nodeId: focused.nodeId,
			kind: focused.kind,
			workspaceRevision: interactions.getWorkspaceRevision(),
		});
	};
	const mountLoading = (): void => {
		clearEditor();
		inspector?.remove();
		const root = ownerDocument.createElement('section');
		const loading = ownerDocument.createElement('div');

		root.className = 'workspace-node-inspector is-loading';
		root.setAttribute(GRAPH_CAMERA_IGNORE_ATTRIBUTE, '');
		root.setAttribute('aria-live', 'polite');
		loading.className = 'workspace-node-inspector-status';
		loading.textContent = 'Loading details…';
		root.append(loading);
		overlayLayer.append(root);
		inspector = root;
		refreshPosition();
	};
	const showError = (message: string): void => {
		if (!inspector) {
			return;
		}
		let status = inspector.querySelector<HTMLElement>(
			'.workspace-node-inspector-status',
		);

		if (!status) {
			status = ownerDocument.createElement('div');
			status.className = 'workspace-node-inspector-status is-error';
			inspector.append(status);
		}
		status.classList.add('is-error');
		status.textContent = message;
	};
	const mountDetails = (nextDetails: WorkspaceNodeDetails): void => {
		if (!focused || nextDetails.nodeId !== focused.nodeId) {
			return;
		}
		details = nextDetails;
		clearEditor();
		inspector?.remove();
		const root = ownerDocument.createElement('section');
		const header = ownerDocument.createElement('header');
		const heading = ownerDocument.createElement('strong');
		const closeButton = ownerDocument.createElement('button');
		const body = ownerDocument.createElement('div');
		const metadata = ownerDocument.createElement('dl');
		const controls = ownerDocument.createElement('div');
		const nameField = ownerDocument.createElement('label');
		const nameLabel = ownerDocument.createElement('span');
		const nameRow = ownerDocument.createElement('div');
		const nameInput = ownerDocument.createElement('input');
		const renameButton = ownerDocument.createElement('button');
		const deleteButton = ownerDocument.createElement('button');
		const mutable = nextDetails.canMutate && !nextDetails.readonly;

		root.className = `workspace-node-inspector is-${nextDetails.kind}`;
		root.setAttribute(GRAPH_CAMERA_IGNORE_ATTRIBUTE, '');
		root.setAttribute('role', 'dialog');
		root.setAttribute('aria-label', `${nextDetails.name} details`);
		header.className = 'workspace-node-inspector-header';
		heading.textContent = nextDetails.kind === 'file' ? 'FILE' : 'FOLDER';
		closeButton.type = 'button';
		closeButton.className = 'workspace-node-inspector-close';
		closeButton.textContent = '×';
		closeButton.setAttribute('aria-label', 'Close details');
		closeButton.addEventListener('click', close);
		header.append(heading, closeButton);
		body.className = 'workspace-node-inspector-body';
		metadata.className = 'workspace-node-metadata';
		appendMetadata(metadata, 'Path', nextDetails.relativePath);
		if (nextDetails.size !== undefined) {
			appendMetadata(metadata, 'Size', formatBytes(nextDetails.size));
		}
		if (nextDetails.modifiedAt !== undefined) {
			appendMetadata(metadata, 'Modified', formatTimestamp(nextDetails.modifiedAt));
		}
		if (nextDetails.createdAt !== undefined) {
			appendMetadata(metadata, 'Created', formatTimestamp(nextDetails.createdAt));
		}
		if (nextDetails.childFolderCount !== undefined) {
			appendMetadata(metadata, 'Subfolders', String(nextDetails.childFolderCount));
		}
		if (nextDetails.childFileCount !== undefined) {
			appendMetadata(metadata, 'Files', String(nextDetails.childFileCount));
		}
		appendMetadata(metadata, 'Access', nextDetails.readonly ? 'Read-only' : 'Read/write');
		controls.className = 'workspace-node-inspector-controls';
		nameField.className = 'workspace-node-name-field';
		nameLabel.textContent = nextDetails.kind === 'file' ? 'File name' : 'Folder name';
		nameRow.className = 'workspace-node-name-row';
		nameInput.type = 'text';
		nameInput.value = nextDetails.name;
		nameInput.disabled = !mutable;
		nameInput.setAttribute('aria-label', nameLabel.textContent);
		renameButton.type = 'button';
		renameButton.textContent = 'Rename';
		renameButton.disabled = !mutable;
		renameButton.addEventListener('click', () => {
			if (!focused || !details || pendingMutationRequestId !== undefined) {
				return;
			}
			pendingMutationRequestId = nextRequestId();
			setMutationPending(root, true);
			interactions.postRequest({
				type: 'workspace.nodeRename.request',
				requestId: pendingMutationRequestId,
				nodeId: focused.nodeId,
				kind: focused.kind,
				newName: nameInput.value,
				workspaceRevision: interactions.getWorkspaceRevision(),
				state: interactions.getWorkspaceState(),
			});
		});
		nameRow.append(nameInput, renameButton);
		nameField.append(nameLabel, nameRow);
		deleteButton.type = 'button';
		deleteButton.className = 'workspace-node-delete';
		deleteButton.textContent = nextDetails.kind === 'file' ? 'Delete File' : 'Delete Folder';
		deleteButton.disabled = !mutable;
		deleteButton.addEventListener('click', () => {
			showDeleteConfirmation(root);
		});
		controls.append(nameField, metadata);
		if (!mutable) {
			const notice = ownerDocument.createElement('p');

			notice.className = 'workspace-node-mutation-notice';
			notice.textContent = nextDetails.readonly
				? 'Read-only items cannot be renamed or deleted.'
				: 'Items cannot be changed in a restricted Workspace or virtual file system.';
			controls.append(notice);
		}
		controls.append(deleteButton);
		if (nextDetails.kind === 'file') {
			const preview = ownerDocument.createElement('div');

			preview.className = 'workspace-node-code-preview';
			body.append(preview, controls);
			mountCodePreview(preview, nextDetails);
		} else {
			body.append(controls);
		}
		root.append(header, body);
		overlayLayer.append(root);
		inspector = root;
		refreshPosition();
	};
	const mountCodePreview = (
		container: HTMLElement,
		nodeDetails: WorkspaceNodeDetails,
	): void => {
		const preview = nodeDetails.preview;

		if (!preview || preview.status !== 'ready') {
			container.classList.add('is-unavailable');
			container.textContent = preview?.status === 'too-large'
				? 'Files larger than 1 MiB cannot be previewed.'
				: preview?.status === 'binary'
					? 'Binary files cannot be previewed.'
					: 'The file preview could not be loaded.';
			return;
		}
		const generation = previewGeneration;

		container.classList.add('is-loading');
		container.textContent = 'Preparing code preview…';

		void Promise.all([
			import('monaco-editor/esm/vs/editor/editor.api.js'),
			import('monaco-editor/esm/vs/basic-languages/monaco.contribution.js'),
		]).then(([monaco]) => {
			if (
				disposed
				|| generation !== previewGeneration
				|| !container.isConnected
			) {
				return;
			}
			container.classList.remove('is-loading');
			container.textContent = '';
			monacoApi = monaco;
			monaco.editor.setTheme(resolveMonacoTheme(ownerDocument.body));
			if (preview.originalText !== undefined) {
				const originalModel = monaco.editor.createModel(
					preview.originalText,
					preview.languageId,
				);
				const modifiedModel = monaco.editor.createModel(
					preview.text,
					preview.languageId,
				);
				const diffEditor = monaco.editor.createDiffEditor(container, {
					readOnly: true,
					originalEditable: false,
					automaticLayout: true,
					renderSideBySide: false,
					useInlineViewWhenSpaceIsLimited: true,
					originalAriaLabel: `${nodeDetails.name} Git HEAD original`,
					modifiedAriaLabel: `${nodeDetails.name} current file changes`,
					minimap: { enabled: false },
					lineNumbersMinChars: 3,
					scrollBeyondLastLine: false,
					renderValidationDecorations: 'off',
					contextmenu: true,
					wordWrap: 'off',
					theme: resolveMonacoTheme(ownerDocument.body),
				});

				diffEditor.setModel({
					original: originalModel,
					modified: modifiedModel,
				});
				models = [originalModel, modifiedModel];
				editor = diffEditor;
				container.classList.add('is-git-diff');
			} else {
				const codeModel = monaco.editor.createModel(
					preview.text,
					preview.languageId,
				);

				models = [codeModel];
				editor = monaco.editor.create(container, {
					model: codeModel,
					readOnly: true,
					domReadOnly: true,
					automaticLayout: true,
					ariaLabel: `${nodeDetails.name} read-only code preview`,
					minimap: { enabled: false },
					lineNumbersMinChars: 3,
					scrollBeyondLastLine: false,
					renderValidationDecorations: 'off',
					contextmenu: true,
					wordWrap: 'off',
					theme: resolveMonacoTheme(ownerDocument.body),
				});
			}
		}).catch(() => {
			if (generation === previewGeneration && container.isConnected) {
				container.classList.remove('is-loading');
				container.classList.add('is-unavailable');
				container.textContent = 'The code preview could not be initialized.';
			}
		});
	};
	const showDeleteConfirmation = (root: HTMLElement): void => {
		if (!focused || !details || root.querySelector('.workspace-node-confirm')) {
			return;
		}
		const dialog = ownerDocument.createElement('div');
		const message = ownerDocument.createElement('p');
		const actions = ownerDocument.createElement('div');
		const cancel = ownerDocument.createElement('button');
		const confirm = ownerDocument.createElement('button');

		dialog.className = 'workspace-node-confirm';
		dialog.setAttribute('role', 'alertdialog');
		message.textContent = focused.kind === 'folder'
			? 'Move this folder and all of its contents to Trash? Related graph state and Task references will also be removed.'
			: 'Move this file to Trash? Related graph state and Task references will also be removed.';
		actions.className = 'workspace-node-confirm-actions';
		cancel.type = 'button';
		cancel.className = 'workspace-node-confirm-cancel';
		cancel.textContent = 'Cancel';
		cancel.addEventListener('click', () => dialog.remove());
		confirm.type = 'button';
		confirm.className = 'workspace-node-confirm-delete';
		confirm.textContent = 'Delete';
		confirm.addEventListener('click', () => {
			if (!focused || pendingMutationRequestId !== undefined) {
				return;
			}
			pendingMutationRequestId = nextRequestId();
			setMutationPending(root, true);
			dialog.remove();
			interactions.postRequest({
				type: 'workspace.nodeDelete.request',
				requestId: pendingMutationRequestId,
				nodeId: focused.nodeId,
				kind: focused.kind,
				workspaceRevision: interactions.getWorkspaceRevision(),
			});
		});
		actions.append(cancel, confirm);
		dialog.append(message, actions);
		root.append(dialog);
		cancel.focus();
	};
	const handleContextMenu = (event: MouseEvent): void => {
		const target = resolveWorkspaceNodeContextTarget(event.target);

		if (!target) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		if (pendingMutationRequestId !== undefined) {
			return;
		}
		details = undefined;
		focusNode(target);
		mountLoading();
		requestDetails();
	};
	graphArea.addEventListener('contextmenu', handleContextMenu);
	const disposeDismissal = initializeWorkspaceNodeInspectorDismissal(
		ownerDocument,
		() => inspector,
		close,
	);

	return {
		handleDetailsResult(message): void {
			if (message.requestId !== pendingDetailsRequestId) {
				return;
			}
			pendingDetailsRequestId = undefined;
			if (message.status === 'success') {
				mountDetails(message.details);
			} else {
				showError(formatFailure(message.reason));
			}
		},
		handleMutationResult(message): void {
			if (message.requestId !== pendingMutationRequestId) {
				return;
			}
			pendingMutationRequestId = undefined;
			if (message.status === 'error') {
				if (inspector) {
					setMutationPending(inspector, false);
				}
				showError(formatFailure(message.reason));
				return;
			}
			if (message.operation === 'delete') {
				close();
				return;
			}
			if (focused && message.nodeId) {
				clearFocusedStyle();
				const element = findWorkspaceNodeElement(
					graphArea,
					message.nodeId,
					focused.kind,
				);

				if (!element) {
					close();
					return;
				}
				focused = { ...focused, nodeId: message.nodeId, element };
				element.classList.add('is-workspace-node-focused');
				mountLoading();
				requestDetails();
			}
		},
		refreshPosition,
		dispose(): void {
			if (disposed) {
				return;
			}
			disposed = true;
			graphArea.removeEventListener('contextmenu', handleContextMenu);
			disposeDismissal();
			themeObserver?.disconnect();
			monacoApi = undefined;
			close();
		},
	};
}

function findWorkspaceNodeElement(
	graphArea: HTMLElement,
	nodeId: string,
	kind: WorkspaceMutableNodeKind,
): HTMLElement | undefined {
	if (kind === 'file') {
		return [...graphArea.querySelectorAll<HTMLElement>('[data-file-id]')].find(
			(element) => element.getAttribute('data-file-id') === nodeId
				&& !element.hasAttribute('data-graph-backlink'),
		);
	}
	return [...graphArea.querySelectorAll<HTMLElement>('.graph-folder-node')].find(
		(element) => {
			const occurrenceId = element.getAttribute('data-graph-node-id');

			return occurrenceId !== null
				&& getGraphLayoutSourceId(occurrenceId) === nodeId
				&& !element.hasAttribute('data-graph-backlink');
		},
	);
}

export function resolveWorkspaceNodeContextTarget(
	target: EventTarget | null,
): FocusedWorkspaceNode | undefined {
	if (!(target instanceof Element)) {
		return undefined;
	}
	const element = target.closest<HTMLElement>(
		'.graph-file-item, .graph-file-group-node[data-file-group-presentation="standalone"], .graph-folder-node',
	);

	if (
		!element
		|| element.hasAttribute('data-graph-backlink')
		|| element.classList.contains('graph-folder-backlink-node')
	) {
		return undefined;
	}
	const fileId = element.getAttribute('data-file-id');

	if (fileId?.startsWith('file:')) {
		return { nodeId: fileId, kind: 'file', element };
	}
	if (!element.classList.contains('graph-folder-node')) {
		return undefined;
	}
	const occurrenceId = element.getAttribute('data-graph-node-id');
	const nodeId = occurrenceId ? getGraphLayoutSourceId(occurrenceId) : undefined;

	return nodeId?.startsWith('folder:')
		? { nodeId, kind: 'folder', element }
		: undefined;
}

function appendMetadata(root: HTMLDListElement, label: string, value: string): void {
	const term = root.ownerDocument.createElement('dt');
	const description = root.ownerDocument.createElement('dd');

	term.textContent = label;
	description.textContent = value;
	root.append(term, description);
}

function setMutationPending(root: HTMLElement, pending: boolean): void {
	root.classList.toggle('is-mutation-pending', pending);
	for (const control of root.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
		'input, button',
	)) {
		control.disabled = pending;
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1_024) {
		return `${bytes} B`;
	}
	if (bytes < 1_048_576) {
		return `${(bytes / 1_024).toFixed(1)} KiB`;
	}
	return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

function formatTimestamp(timestamp: number): string {
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(new Date(timestamp));
}

function resolveMonacoTheme(body: HTMLElement): string {
	const themeKind = body.getAttribute('data-vscode-theme-kind');

	if (
		body.classList.contains('vscode-high-contrast-light')
		|| themeKind === 'vscode-high-contrast-light'
	) {
		return 'hc-light';
	}
	if (
		body.classList.contains('vscode-high-contrast')
		|| themeKind === 'vscode-high-contrast'
	) {
		return 'hc-black';
	}
	return body.classList.contains('vscode-light')
		|| themeKind === 'vscode-light'
		? 'vs'
		: 'vs-dark';
}

function formatFailure(reason: string): string {
	const messages: Readonly<Record<string, string>> = {
		stale: 'The Workspace has changed. Select the node again.',
		'not-found': 'The file or folder could not be found.',
		'not-allowed': 'This operation is not available in the current Workspace.',
		'read-only': 'Read-only items cannot be changed.',
		conflict: 'An item with the same name already exists.',
		'invalid-name': 'This name cannot be used.',
		unsupported: 'The current file system does not support this operation.',
		failed: 'The operation could not be completed.',
	};

	return messages[reason] ?? messages.failed;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(Math.max(value, minimum), maximum);
}
