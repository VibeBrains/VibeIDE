/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolDef } from './_helpers.js';

/**
 * След урока — единственное, что переживает конец треда.
 *
 * Пишет файл в учебной папке, поэтому проходит гейт правок: запись в проект пользователя без его
 * ведома недопустима, даже когда запись безобидная.
 */
export const LEARNING_RECORD_TOOL: ToolDef<'learning_record'> = {
	name: 'learning_record',
	approvalType: 'edits',
	description: `Write down what the learner actually took away from a lesson, and what they did not. Call this at the END of every lesson — before the thread ends, because nothing else survives it.

'stuck' is data, not a complaint: repeated entries are what makes the next lesson step back instead of pressing on. So list difficulties as short, comparable topics ("zero article", "async generators"), the same wording you would use next time — 'it was a bit hard' cannot be compared with anything.

Record what was demonstrated, not what was covered. If the learner answered an exercise correctly, that is a 'learned' item; if they only nodded along, it is not. An over-generous record makes the next lesson too hard, which is the failure mode that ends learning altogether.

An empty 'stuck' list is a real answer, and a consequential one: enough clean lessons in a row and the difficulty goes up. Do not leave it empty just to be encouraging.`,
	params: {
		lesson: {
			description: `Title of the lesson this record belongs to — the topic, not the date.`,
		},
		learned: {
			description: `What the learner demonstrated they can now do. One item per skill, phrased as an ability.`,
		},
		stuck: {
			description: `Short topic names for what did not land. Empty list if nothing did — that is meaningful, not a formality.`,
		},
	},
};
