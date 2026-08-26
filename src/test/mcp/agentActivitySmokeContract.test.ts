import * as assert from 'node:assert/strict';
import type { AgentActivityRequested } from '../../mcp/agentActivityProtocol';
import {
	AGENT_ACTIVITY_SMOKE_ANCHOR,
	AGENT_ACTIVITY_SMOKE_CHILDREN,
	isStrictAgentActivitySmokeLifecycle,
} from '../../mcp/agentActivitySmokeContract';

const sessionId = 'strict-lifecycle-session';
const generation = 'strict-lifecycle-generation';

suite('Strict cross-agent Activity smoke contract', () => {
	test('accepts planned anchor, meaningful children, cleanup, and final completion', () => {
		assert.strictEqual(
			isStrictAgentActivitySmokeLifecycle(validLifecycle()),
			true,
		);
	});

	test('rejects a missing child clear', () => {
		const events = validLifecycle().filter((event) => !(
			event.operation === 'clear'
			&& event.path === AGENT_ACTIVITY_SMOKE_CHILDREN[1]
		));
		assert.strictEqual(isStrictAgentActivitySmokeLifecycle(events), false);
	});

	test('rejects completion before a later descendant marker', () => {
		const events = [
			...validLifecycle(),
			set(AGENT_ACTIVITY_SMOKE_CHILDREN[0], 'file', 'mentioned'),
		];
		assert.strictEqual(isStrictAgentActivitySmokeLifecycle(events), false);
	});

	test('rejects work that starts without a planned completion anchor', () => {
		const events = validLifecycle();
		events[0] = set(AGENT_ACTIVITY_SMOKE_ANCHOR, 'folder', 'active');
		assert.strictEqual(isStrictAgentActivitySmokeLifecycle(events), false);
	});

	test('rejects an unrelated target in the bounded smoke request', () => {
		const events = validLifecycle();
		events.splice(-1, 0, set('README.md', 'file', 'mentioned'));
		assert.strictEqual(isStrictAgentActivitySmokeLifecycle(events), false);
	});
});

function validLifecycle(): AgentActivityRequested[] {
	return [
		set(AGENT_ACTIVITY_SMOKE_ANCHOR, 'folder', 'planned'),
		set(AGENT_ACTIVITY_SMOKE_CHILDREN[0], 'file', 'active'),
		set(AGENT_ACTIVITY_SMOKE_CHILDREN[1], 'file', 'active'),
		clear(AGENT_ACTIVITY_SMOKE_CHILDREN[1]),
		clear(AGENT_ACTIVITY_SMOKE_CHILDREN[0]),
		set(AGENT_ACTIVITY_SMOKE_ANCHOR, 'folder', 'completed'),
	];
}

function set(
	path: string,
	targetKind: 'file' | 'folder',
	activity: 'planned' | 'active' | 'completed' | 'mentioned',
): AgentActivityRequested {
	return {
		type: 'session.agentActivityRequested',
		sessionId,
		generation,
		operation: 'set',
		path,
		targetKind,
		activity,
	};
}

function clear(path: string): AgentActivityRequested {
	return {
		type: 'session.agentActivityRequested',
		sessionId,
		generation,
		operation: 'clear',
		path,
		targetKind: 'file',
	};
}
