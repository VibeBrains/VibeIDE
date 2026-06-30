/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../../../../common/vibeLog.js';
import React, { useEffect, useState } from 'react';
import * as ReactDOM from 'react-dom/client';
import { _registerServices } from './services.js';


import { ServicesAccessor } from '../../../../../../../editor/browser/editorExtensions.js';

export const mountFnGenerator = (Component: (params: any) => React.ReactNode) => (rootElement: HTMLElement, accessor: ServicesAccessor, props?: any) => {
	if (typeof document === 'undefined') {
		vibeLog.error('mountFnGenerator', 'index.tsx error: document was undefined');
		return;
	}

	const disposables = _registerServices(accessor);

	const root = ReactDOM.createRoot(rootElement);

	const rerender = (props?: any) => {
		root.render(<Component {...props} />); // tailwind dark theme indicator
	};
	const dispose = () => {
		root.unmount();
		disposables.forEach(d => d.dispose());
	};

	rerender(props);

	const returnVal = {
		rerender,
		dispose,
	};
	return returnVal;
};
