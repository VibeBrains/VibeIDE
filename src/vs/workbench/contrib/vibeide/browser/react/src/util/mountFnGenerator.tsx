/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useEffect, useState } from 'react';
import * as ReactDOM from 'react-dom/client'
import { _registerServices } from './services.js';


import { ServicesAccessor } from '../../../../../../../editor/browser/editorExtensions.js';

export const mountFnGenerator = (Component: (params: any) => React.ReactNode) => (rootElement: HTMLElement, accessor: ServicesAccessor, props?: any) => {
	if (typeof document === 'undefined') {
		console.error('index.tsx error: document was undefined')
		return
	}

	const t0 = performance.now()
	console.warn('[mountFn] _registerServices() — start')
	const disposables = _registerServices(accessor)
	const tReg = performance.now() - t0
	console.warn(`[mountFn] _registerServices() — done in ${tReg.toFixed(1)}ms, disposables=${disposables.length}`)

	const root = ReactDOM.createRoot(rootElement)

	const rerender = (props?: any) => {
		const trStart = performance.now()
		root.render(<Component {...props} />); // tailwind dark theme indicator
		const trDt = performance.now() - trStart
		console.warn(`[mountFn] root.render() returned in ${trDt.toFixed(1)}ms`)
	}
	const dispose = () => {
		root.unmount();
		disposables.forEach(d => d.dispose());
	}

	rerender(props)

	const returnVal = {
		rerender,
		dispose,
	}
	return returnVal
}
