import { createValidPlan } from '../testFixtures';

const scenario = process.argv[2] ?? 'success';

process.stdin.resume();
process.stdin.once('end', () => {
	switch (scenario) {
		case 'success':
			writeEvent({ type: 'thread.started', thread_id: 'fake-thread' });
			setTimeout(() => {
				writeEvent({
					type: 'item.started',
					item: { id: 'command-1', type: 'command_execution', command: 'rg --files src' },
				});
				process.stderr.write('fake warning\n');
				writeAgentMessage(createValidPlan());
				writeEvent({ type: 'turn.completed' });
			}, 10);
			break;
		case 'malformed':
			process.stdout.write('not-json\n');
			writeAgentMessage(createValidPlan());
			break;
		case 'no-message':
			writeEvent({ type: 'turn.completed' });
			break;
		case 'nonzero':
			process.stderr.write('fake failure\n');
			process.exitCode = 7;
			break;
		case 'provider-error':
			writeEvent({ type: 'error', message: 'fake provider detail' });
			writeEvent({ type: 'turn.failed', error: { message: 'fake provider detail' } });
			process.exitCode = 9;
			break;
		case 'wait':
			writeEvent({ type: 'thread.started', thread_id: 'waiting-thread' });
			setInterval(() => undefined, 1_000);
			break;
		default:
			process.stderr.write(`unknown scenario: ${scenario}\n`);
			process.exitCode = 8;
	}
});

function writeAgentMessage(plan: unknown): void {
	writeEvent({
		type: 'item.completed',
		item: { id: 'message-1', type: 'agent_message', text: JSON.stringify(plan) },
	});
}

function writeEvent(event: unknown): void {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}
