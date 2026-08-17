/** 프로젝트 Tree 항목이 공통으로 가지는 안정적인 식별 정보다. */
interface ProjectItemBase {
	readonly id: string;
	readonly name: string;
}

/** Graph의 최상위 Project Root와 직접 포함 항목을 나타낸다. */
export interface Project extends ProjectItemBase {
	readonly kind: 'project';
	readonly children: readonly ProjectEntry[];
}

/** 중첩 가능하며 Folder 또는 File을 직접 포함하는 프로젝트 Folder다. */
export interface Folder extends ProjectItemBase {
	readonly kind: 'folder';
	readonly children: readonly ProjectEntry[];
}

/** Parent Folder의 File Group에 표시되는 개별 File 정보다. */
export interface File extends ProjectItemBase {
	readonly kind: 'file';
}

/** Project 또는 Folder가 직접 포함할 수 있는 항목이다. */
export type ProjectEntry = Folder | File;

/** Child 항목을 가지며 별도 File Group을 생성할 수 있는 항목이다. */
export type ProjectContainer = Project | Folder;

/**
 * 프로젝트 항목이 Folder인지 판별한다.
 *
 * @param entry 판별할 프로젝트 항목
 * @returns Folder이면 true
 */
export function isFolder(entry: ProjectEntry): entry is Folder {
	return entry.kind === 'folder';
}

/**
 * 프로젝트 항목이 File인지 판별한다.
 *
 * @param entry 판별할 프로젝트 항목
 * @returns File이면 true
 */
export function isFile(entry: ProjectEntry): entry is File {
	return entry.kind === 'file';
}
