/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../../../../common/vibeLog.js';
import React, { useEffect, useState } from 'react';
import * as ReactDOM from 'react-dom/client';
import { _registerServices } from './services.js';


import { ServicesAccessor } from '../../../../../../../editor/browser/editorExtensions.js';

// `React.ComponentType`, not `(params: any) => React.ReactNode`: the latter excludes components
// typed as `React.FC<…>` (their return type is `ReactNode | Promise<ReactNode>`), which is what
// every entry point here actually passes.
export const mountFnGenerator = (Component: React.ComponentType<any>) => (rootElement: HTMLElement, accessor: ServicesAccessor, props?: any) => {
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
