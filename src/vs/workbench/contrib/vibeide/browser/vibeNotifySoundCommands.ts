/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IVibeNotifySoundService } from './vibeNotifySoundService.js';

// Lets the user hear the currently-selected notification sound from the command palette.
// The richer per-variant click-preview lives in the settings UI (phase 2).
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.notify.sound.preview',
			title: localize2('vibeide.notify.sound.preview', 'VibeIDE: Прослушать звук уведомления'),
			category: localize2('vibeide.notify.category', 'VibeIDE'),
			f1: true,
		});
	}
	run(accessor: ServicesAccessor): void {
		accessor.get(IVibeNotifySoundService).preview();
	}
});
