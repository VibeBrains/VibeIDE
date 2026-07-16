/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// sherpa-onnx-node ships no typings. The precise shape we consume is typed locally in
// `vs/workbench/contrib/vibeide/node/voice/vibeVoiceWorkerMain.ts` (SherpaApi) — this
// declaration only makes the dynamic import compile.
declare module 'sherpa-onnx-node' {
	const sherpaOnnx: unknown;
	export = sherpaOnnx;
}
