import * as assert from 'node:assert/strict';
import { createGitDecorationStore } from '../../webview/graph/gitDecorationStore';

suite('gitDecorationStore', () => {
	test('file 이름과 direct U/M/R marker를 현재 snapshot에서 즉시 동기화한다', () => {
		const store = createGitDecorationStore(3, ['workspace-root:file:///root']);

		assert.equal(store.applySnapshot({
			type: 'workspace.gitStatusUpdated',
			contextGeneration: 3,
			rootIds: ['workspace-root:file:///root'],
			gitRevision: 1,
			entries: [{
				status: 'modified',
				nodeId: 'file:file:///root/file.ts',
				ancestorNodeIds: ['workspace-root:file:///root'],
			}],
		}), true);
		const element = createTargetElement('graph-file-name');
		const cleanup = store.registerFile('file:file:///root/file.ts', element.html);
		const marker = element.root.children.at(-1);

		assert.equal(element.name.getAttribute('data-git-status'), 'modified');
		assert.equal(marker?.textContent, 'M');
		assert.equal(marker?.hidden, false);
		assert.equal(marker?.getAttribute('title'), 'Git: Modified');

		cleanup();
		assert.equal(element.name.getAttribute('data-git-status'), undefined);
		assert.equal(element.root.children.length, 1);
	});

	test('folder는 descendant 상태만 집계하고 우선순위 색상의 원 marker를 쓴다', () => {
		const store = createGitDecorationStore(0, ['workspace-root:file:///root']);
		const element = createTargetElement('graph-folder-name');

		store.registerContainer('folder:file:///root/src', element.html);
		store.applySnapshot({
			type: 'workspace.gitStatusUpdated',
			contextGeneration: 0,
			rootIds: ['workspace-root:file:///root'],
			gitRevision: 4,
			entries: [
				{
					status: 'modified',
					nodeId: 'file:file:///root/src/a.ts',
					ancestorNodeIds: ['folder:file:///root/src'],
				},
				{
					status: 'deleted',
					ancestorNodeIds: ['folder:file:///root/src'],
				},
			],
		});
		const marker = element.root.children.at(-1);

		assert.equal(element.name.getAttribute('data-git-status'), 'deleted');
		assert.equal(marker?.textContent, '');
		assert.equal(marker?.getAttribute('title'), 'Git changes: D 1, M 1');
	});

	test('다른 context와 오래된 revision을 거부하고 context reset은 장식을 지운다', () => {
		const store = createGitDecorationStore(1, ['workspace-root:file:///root']);
		const element = createTargetElement('graph-file-name');

		store.registerFile('file:file:///root/file.ts', element.html);
		assert.equal(store.applySnapshot({
			type: 'workspace.gitStatusUpdated',
			contextGeneration: 2,
			rootIds: ['workspace-root:file:///root'],
			gitRevision: 1,
			entries: [],
		}), false);
		assert.equal(store.applySnapshot({
			type: 'workspace.gitStatusUpdated',
			contextGeneration: 1,
			rootIds: ['workspace-root:file:///root'],
			gitRevision: 2,
			entries: [{
				status: 'untracked',
				nodeId: 'file:file:///root/file.ts',
				ancestorNodeIds: [],
			}],
		}), true);
		assert.equal(store.applySnapshot({
			type: 'workspace.gitStatusUpdated',
			contextGeneration: 1,
			rootIds: ['workspace-root:file:///root'],
			gitRevision: 2,
			entries: [],
		}), false);
		assert.equal(element.name.getAttribute('data-git-status'), 'untracked');

		store.resetContext(2, ['workspace-root:file:///next']);
		assert.equal(element.name.getAttribute('data-git-status'), undefined);
		assert.equal(element.root.children.at(-1)?.hidden, true);
	});
});

function createTargetElement(nameClass: string): {
	readonly html: HTMLElement;
	readonly root: FakeElement;
	readonly name: FakeElement;
} {
	const document = new FakeDocument();
	const root = document.createElement('div');
	const name = document.createElement('span');

	name.className = nameClass;
	root.append(name);

	return { html: root as unknown as HTMLElement, root, name };
}

class FakeDocument {
	createElement(_tagName: string): FakeElement {
		return new FakeElement(this);
	}
}

class FakeElement {
	className = '';
	textContent = '';
	hidden = false;
	readonly children: FakeElement[] = [];
	readonly attributes = new Map<string, string>();
	private parent: FakeElement | undefined;

	constructor(readonly ownerDocument: FakeDocument) {}

	append(...children: FakeElement[]): void {
		for (const child of children) {
			child.parent = this;
		}
		this.children.push(...children);
	}

	querySelector(selector: string): FakeElement | null {
		const className = selector.startsWith('.') ? selector.slice(1) : selector;

		return this.children.find((child) => child.className === className) ?? null;
	}

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}

	getAttribute(name: string): string | undefined {
		return this.attributes.get(name);
	}

	removeAttribute(name: string): void {
		this.attributes.delete(name);
	}

	remove(): void {
		const index = this.parent?.children.indexOf(this) ?? -1;

		if (index >= 0) {
			this.parent?.children.splice(index, 1);
		}
		this.parent = undefined;
	}
}
