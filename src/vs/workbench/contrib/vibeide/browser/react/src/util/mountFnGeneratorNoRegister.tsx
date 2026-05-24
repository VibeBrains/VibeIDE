/*--------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------*/

import React from 'react';
import * as ReactDOM from 'react-dom/client';
import { ServicesAccessor } from '../../../../../../../editor/browser/editorExtensions.js';
import { _registerServices, _isAccessorRegistered } from './services.js';

/**
 * Variant of `mountFnGenerator` that does NOT re-invoke `_registerServices`
 * if the global accessor is already wired. This is critical for
 * workbench-level mounts (VibeModal portal) which fire AFTER the chat
 * sidebar's first mount has already done the registration.
 *
 * `_registerServices` is documented as «should only be called ONCE» —
 * subsequent calls accumulate listeners on global emitters (every
 * `onDidChangeStreamState`/`onDidChangeCurrentThread`/etc gets a duplicate
 * subscription that fires every emitter event multiple times). Symptom
 * observed in the field (commit pre-Z.12): VibeIDE works for the first
 * chat prompt, then freezes on subsequent interactions because the
 * accumulated React-state callbacks pile up and starve the renderer
 * thread.
 *
 * If the accessor wasn't registered yet (first mount in the session),
 * we fall through to the standard `_registerServices` path so the
 * single-call invariant is preserved.
 */
export const mountFnGeneratorNoRegister = (Component: (params: any) => React.ReactNode) => (rootElement: HTMLElement, accessor: ServicesAccessor, props?: any) => {
	if (typeof document === 'undefined') {
		console.error('mountFnGeneratorNoRegister: document was undefined');
		return;
	}

	// Only run `_registerServices` if it hasn't been called yet this session.
	// Otherwise we'd double-subscribe to every global emitter.
	const disposables = _isAccessorRegistered() ? [] : _registerServices(accessor);

	const root = ReactDOM.createRoot(rootElement);

	const rerender = (props?: any) => {
		root.render(<Component {...props} />);
	};
	const dispose = () => {
		root.unmount();
		disposables.forEach(d => d.dispose());
	};

	rerender(props);

	return { rerender, dispose };
};
