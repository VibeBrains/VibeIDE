/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolDef } from './_helpers.js';

/**
 * Состояние учебного workspace — то, с чего начинается каждая учебная сессия.
 *
 * Без параметров намеренно: сужать нечего, ответ целиком и есть контекст обучения. Тот же довод,
 * что у `design_context`.
 */
export const LEARNING_STATE_TOOL: ToolDef<'learning_state'> = {
	name: 'learning_state',
	description: `Read the learner's accumulated progress before teaching anything: their mission, the trusted sources they agreed on, the lessons already taken, what they got stuck on, and the difficulty the next lesson should be pitched at. Read-only.

Call this FIRST in any teaching session. The chat has no memory of previous sessions; this file-backed workspace does.

Two answers decide what you do next:
- 'missionReady' false — the workspace has no usable mission yet. Ask the returned questions, write the answers to the mission file, and only then build a lesson. Teaching without a mission produces a correct, useless retelling of a textbook.
- 'difficulty' — the verdict is computed here from the records, not by you: 'easier' means one difficulty keeps recurring and the next lesson must revisit it rather than move on; 'hold' means keep the current level; 'harder' means recent lessons ran clean and staying put would only simulate progress. Follow it.

Teach from the sources listed in the workspace, not from memory. When something is missing there, say so and ask — a confidently invented fact costs the learner more than a gap.`,
	params: {},
};
