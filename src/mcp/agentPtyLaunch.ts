import type { TerminalSession } from '../agent/host/terminal/terminalSession';
import type { AgentProcessSpawnRequest } from './agentLaunchPlan';

/** Spawns a structured provider request as the PTY root process. */
export function spawnAgentPty(
	session: TerminalSession,
	request: AgentProcessSpawnRequest,
	cols: number,
	rows: number,
): Promise<void> {
	return session.start({
		executable: request.executable,
		args: request.windowsVerbatimArguments
			? request.args.join(' ')
			: request.args,
		cwd: request.cwd,
		env: { ...request.environment },
	}, cols, rows);
}
