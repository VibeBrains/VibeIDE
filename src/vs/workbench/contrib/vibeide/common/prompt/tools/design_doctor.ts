/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ToolDef } from './_helpers.js';

export const DESIGN_DOCTOR_TOOL: ToolDef<'design_doctor'> = {
	name: 'design_doctor',
	description: `Checks whether the design machinery can actually work here, and reports what is missing. Read-only.

Answers four questions the user would otherwise have to guess at:
- Is the design context written (product.md / design.md), and where?
- Can the page be measured right now, or is the preview closed / out of reach?
- How many rules are active, how many the project declared as its identity, and are any of those ids misspelled (a typo there switches off nothing while the project believes it did)?
- Is the automatic design hook on, and in which mode?

Use it when design_review says the page is out of reach, when accepted drift does not seem to apply, or before telling the user the design side is set up.`,
	params: {},
};
