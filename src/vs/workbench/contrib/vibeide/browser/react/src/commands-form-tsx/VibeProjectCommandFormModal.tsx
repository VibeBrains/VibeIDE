/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import React, { useCallback, useEffect, useState } from 'react';
import { useAccessor } from '../util/services.js';
import { VibeModalForm } from '../components/VibeModalForm.js';
import { VibeProjectCommandForm } from '../vibe-settings-tsx/VibeProjectCommandForm.js';

/**
 * Hosts the project-command Add/Edit form (`VibeProjectCommandForm`) inside a resizable modal —
 * replacing the old editor-tab host (`VibeProjectCommandFormPane`). Open/close + props are driven
 * by `IVibeProjectCommandFormModalService`. The form is keyed by mode+id so switching Add↔Edit (or
 * editing a different command) remounts it with fresh state, mirroring the pane's remount behaviour.
 */
export const VibeProjectCommandFormModal: React.FC = () => {
	const accessor = useAccessor();
	const svc = accessor.get('IVibeProjectCommandFormModalService');

	const [, force] = useState(0);
	useEffect(() => {
		const d = svc.onDidChange(() => force(n => n + 1));
		return () => d.dispose();
	}, [svc]);

	const close = useCallback(() => svc.close(), [svc]);

	const open = svc.isOpen;
	const props = svc.props;
	const title = props?.mode === 'edit'
		? 'Редактировать команду проекта'
		: 'Новая команда проекта';

	return (
		<VibeModalForm
			open={open && !!props}
			title={title}
			onClose={close}
			defaultWidth={720}
			defaultHeight={640}
			minWidth={520}
			minHeight={400}
			flushBody
		>
			{props && (
				<div className="@@vibeide-rmodal-scroll">
					<VibeProjectCommandForm
						key={`${props.mode}:${props.commandIdForEdit ?? ''}`}
						mode={props.mode}
						commandIdForEdit={props.commandIdForEdit}
						initialDraft={props.initialDraft}
						onClose={close}
					/>
				</div>
			)}
		</VibeModalForm>
	);
};
