import type {
	ShellFilesystemAdapter,
	ShellFilesystemEntry,
} from './shellFilesystem';
import type {
	ShellLaunchErrorCode,
	ShellLaunchPolicy,
	ShellLaunchPolicyFailure,
	ShellLaunchPolicyResult,
	SupportedShellPlatform,
} from './types';

/** 경로나 exception을 저장하지 않는 Shell 실행 파일 검증 실패를 만든다. */
function validationFailure(
	code: ShellLaunchErrorCode,
): ShellLaunchPolicyFailure {
	return { ok: false, error: { code } };
}

/** unknown filesystem exception에서 안전한 Node 오류 code만 판독한다. */
function filesystemErrorCode(error: unknown): string | undefined {
	if (typeof error !== 'object' || error === null || !('code' in error)) {
		return undefined;
	}

	return typeof error.code === 'string' ? error.code : undefined;
}

/** stat 실패를 경로나 원문을 포함하지 않는 typed 실패로 변환한다. */
function statFailure(error: unknown): ShellLaunchPolicyFailure {
	return validationFailure(
		filesystemErrorCode(error) === 'ENOENT'
			? 'shell_executable_not_found'
			: 'shell_path_invalid',
	);
}

/** POSIX X_OK 실패를 경로나 원문을 포함하지 않는 typed 실패로 변환한다. */
function executePermissionFailure(error: unknown): ShellLaunchPolicyFailure {
	const code = filesystemErrorCode(error);
	if (code === 'ENOENT') {
		return validationFailure('shell_executable_not_found');
	}
	if (code === 'EACCES' || code === 'EPERM') {
		return validationFailure('shell_not_executable');
	}

	return validationFailure('shell_path_invalid');
}

/**
 * 선택된 ShellLaunchPolicy의 executable을 플랫폼 규칙에 맞게 검증한다.
 * Windows는 file 여부까지만 확인하고 POSIX X_OK 검사를 적용하지 않는다.
 *
 * @param platform 이미 지원 대상으로 좁혀진 Host 플랫폼이다.
 * @param policy 플랫폼 resolver가 만든 Host 전용 실행 정책 후보다.
 * @param filesystem filesystem I/O를 격리하는 주입형 adapter다.
 * @returns 검증된 기존 정책 또는 민감 값이 없는 typed 실패다.
 */
export async function validateShellExecutable(
	platform: SupportedShellPlatform,
	policy: ShellLaunchPolicy,
	filesystem: ShellFilesystemAdapter,
): Promise<ShellLaunchPolicyResult> {
	let entry: ShellFilesystemEntry;
	try {
		entry = await filesystem.stat(policy.executable);
	} catch (error) {
		return statFailure(error);
	}

	if (!entry.isFile) {
		return validationFailure('shell_path_not_file');
	}

	if (platform !== 'win32') {
		try {
			await filesystem.checkExecutePermission(policy.executable);
		} catch (error) {
			return executePermissionFailure(error);
		}
	}

	return { ok: true, policy };
}
