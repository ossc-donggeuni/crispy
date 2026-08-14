import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';

/** Shell 경로의 filesystem 종류를 validator에 노출하는 최소 snapshot이다. */
export interface ShellFilesystemEntry {
	readonly isFile: boolean;
}

/**
 * Shell 실행 파일 검증에 필요한 filesystem 연산만 격리한 Host adapter다.
 * 원본 exception은 validator 경계 밖으로 전달하거나 저장하지 않는다.
 */
export interface ShellFilesystemAdapter {
	/** 경로가 가리키는 entry 종류를 조회한다. */
	stat(path: string): Promise<ShellFilesystemEntry>;

	/** POSIX 실행 권한을 검사한다. Windows 검증에서는 호출하지 않는다. */
	checkExecutePermission(path: string): Promise<void>;
}

/** 실제 Extension Host에서 사용하는 Node.js filesystem adapter다. */
export const nodeShellFilesystemAdapter: ShellFilesystemAdapter = {
	async stat(path): Promise<ShellFilesystemEntry> {
		const entry = await stat(path);
		return { isFile: entry.isFile() };
	},

	async checkExecutePermission(path): Promise<void> {
		await access(path, constants.X_OK);
	},
};
