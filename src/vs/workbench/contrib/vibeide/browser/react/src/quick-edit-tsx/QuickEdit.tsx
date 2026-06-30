/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import React, { useEffect, useState } from 'react';
import { useIsDark } from '../util/services.js';
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js';
import { QuickEditChat } from './QuickEditChat.js';
import { QuickEditPropsType } from '../../../quickEditActions.js';

export const QuickEdit = (props: QuickEditPropsType) => {

	const isDark = useIsDark();

	return <div className={`@@vibe-scope @@vibe-react-input-surfaces ${isDark ? 'dark' : ''}`}>
		<ErrorBoundary>
			<QuickEditChat {...props} />
		</ErrorBoundary>
	</div>;


};
