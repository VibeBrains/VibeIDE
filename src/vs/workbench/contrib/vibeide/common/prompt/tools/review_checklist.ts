/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ToolDef } from './_helpers.js';

export const REVIEW_CHECKLIST_TOOL: ToolDef<'review_checklist'> = {
	name: 'review_checklist',
	description: `Hands the user a short "check this with your own eyes" list instead of the word "done".

Use it at the END of a task that changed something a person can look at — a screen, a flow, a command's behaviour. "Done" is a claim; a ticked item is a fact, and the difference is exactly the complaint this exists to answer: an agent reporting success on work that does not actually work.

Rules that make the list worth anything:
- Check first, THEN write the list. Open the preview, run the command, read the output — verify what you can verify yourself, and list what only a human can judge.
- Write items the user can act on without reading your code: "the Save button turns grey while saving", not "isSaving state added". Name the place and the expected outcome.
- 'how' is where the user clicks and what should happen. Skip it only when the item is self-evident.
- 3–7 items. A list of fifteen is not checked, it is scrolled past.
- Do NOT list what you did not change. This is a verification list, not a summary of your work.

The user ticks each item; whatever they mark broken comes back to you with their words, and the task is not closed until it does. An item left unticked also comes back — unverified is not the same as working.

One live checklist per thread: a second call replaces the first.`,
	params: {
		summary: { description: `One line: what you consider done. Shown above the list.` },
		items: { description: `The list itself. Array of objects: { "text": "what to check", "how": "where to click and what should happen (optional)" }.` },
	},
};
