export type ProjectNodeType =
	| 'project'
	| 'application'
	| 'directory'
	| 'file'
	| 'symbol';

export type ProjectNode = {
	id: string;
	type: ProjectNodeType;
	name: string;
	relativePath?: string;
	parentId?: string;
	childrenIds: string[];
};

export type SharedSelection = {
	selectedTaskId?: string;
	selectedNodeId?: string;
};

export type NodePlanInfo = {
	nodeId: string;
	relation: 'direct' | 'reference' | 'possible-impact';
	changes: Array<'create' | 'modify' | 'delete'>;
	taskIds: string[];
	matchStatus: 'resolved' | 'scoped' | 'unresolved';
	hasMultipleWriteTasks: boolean;
};

export type GraphPosition = {
	x: number;
	y: number;
};

export type GraphViewport = GraphPosition & {
	zoom: number;
};
