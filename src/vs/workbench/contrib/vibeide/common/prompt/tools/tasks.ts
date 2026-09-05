/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolDef } from './_helpers.js';

/**
 * One tool with three actions rather than three tools.
 *
 * A model choosing between `task_create`, `task_transition` and `task_list` has to hold three names
 * and their differences; choosing an `action` on one tool is the same decision made once, with the
 * options in front of it.
 */
export const TASKS_TOOL: ToolDef<'tasks'> = {
	name: 'tasks',
	description: `The project's task register — work that outlives this conversation.

Unlike a plan inside the chat, entries here survive a restart, name what they wait for, and refuse a state change that makes no sense. Use it for work that spans more than one exchange: a backlog the user dictated, steps you cannot finish now, anything that must be picked up later or by someone else.

Actions:
- 'list' — what is in the register and what each task is waiting for. Call this before creating, so you do not duplicate work already there.
- 'create' — add a task. Optionally give 'dependency_ids' from a previous 'list': a task that waits for others cannot be started until they are done.
- 'transition' — move a task. Legal moves only: inbox → planned → ready → running → review → done, plus 'blocked' and 'cancelled' from most states. 'done' and 'cancelled' are final; reopening means creating a new task.

Rules the register enforces, so you do not have to check them yourself:
- an illegal transition is refused and named — nothing is silently applied;
- starting a task whose dependencies are unfinished is refused, and the answer lists what it waits for;
- a dependency cycle is refused when the task is created;
- moving a task to 'blocked' requires 'blocked_reason' — «blocked» with no reason is a state nobody can act on.

Repeating a call with the same 'intent' changes nothing and returns the earlier result. Pass the SAME 'intent' when retrying after a failure, and a NEW one for genuinely new work — that is what stops a retry from creating a second task.

Every change is recorded in the audit journal under your name.`,
	params: {
		action: { description: `'list', 'create' or 'transition'.` },
		title: { description: `For 'create': what needs doing, in the user's own words. Ignored by other actions.` },
		task_id: { description: `For 'transition': which task, as returned by 'list'.` },
		to: { description: `For 'transition': target state — 'planned', 'ready', 'running', 'review', 'done', 'blocked' or 'cancelled'.` },
		blocked_reason: { description: `Required when 'to' is 'blocked': what exactly is in the way.` },
		dependency_ids: { description: `For 'create': ids of tasks this one waits for. Take them from 'list'; a made-up id counts as unfinished and will block the task.` },
		intent: { description: `Your own identifier of this request. Reuse it verbatim when retrying the same call; use a fresh one for new work.` },
	},
};
