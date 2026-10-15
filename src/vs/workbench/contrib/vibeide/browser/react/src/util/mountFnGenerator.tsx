/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../../../../common/vibeLog.js';
import React, { useEffect, useState } from 'react';
import * as ReactDOM from 'react-dom/client';
import { _registerServices } from './services.js';


import { ServicesAccessor } from '../../../../../../../editor/browser/editorExtensions.js';

const ownerDocumentOf = Object.getOwnPropertyDescriptor(Node.prototype, 'ownerDocument')?.get;
const documentViews = new WeakMap<Document, Document>();

/**
 * React creates nodes through the `ownerDocument` of its container, and an auxiliary window refuses `createElement`:
 * the workbench wants every element made in the main window so that `instanceof HTMLElement` keeps working
 * The container hands React a view of its real document whose `createElement` goes to the main window;
 * the node is adopted into the auxiliary window as soon as it is appended, everything else stays with the real document
 * The view follows the container: an editor moved to another window keeps rendering
 */
function letReactCreateNodesInMainWindow(rootElement: HTMLElement): void {
	if (!ownerDocumentOf) { return; }
	Object.defineProperty(rootElement, 'ownerDocument', {
		configurable: true,
		get: () => {
			const real = ownerDocumentOf.call(rootElement) as Document;
			if (real === document) { return real; }
			let view = documentViews.get(real);
			if (!view) {
				view = new Proxy(real, {
					get: (target, key) => {
						if (key === 'createElement') { return (...args: Parameters<Document['createElement']>) => document.createElement(...args); }
						const value = Reflect.get(target, key, target);
						return typeof value === 'function' ? value.bind(target) : value;
					},
				});
				documentViews.set(real, view);
			}
			return view;
		},
	});
}

// `React.ComponentType`, not `(params: any) => React.ReactNode`: the latter excludes components
// typed as `React.FC<…>` (their return type is `ReactNode | Promise<ReactNode>`), which is what
// every entry point here actually passes.
export const mountFnGenerator = (Component: React.ComponentType<any>) => (rootElement: HTMLElement, accessor: ServicesAccessor, props?: any) => {
	if (typeof document === 'undefined') {
		vibeLog.error('mountFnGenerator', 'index.tsx error: document was undefined');
		return;
	}

	const disposables = _registerServices(accessor);

	letReactCreateNodesInMainWindow(rootElement);
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
