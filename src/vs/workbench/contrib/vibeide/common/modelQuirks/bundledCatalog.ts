/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * In-tree fallback for the model-quirks catalog.
 *
 * Loads `resources/model-quirks.json` via a dynamic `import(..., { with: { type: 'json' } })` —
 * `tsconfig.json:resolveJsonModule: true` is enabled, esbuild's `.json` loader
 * inlines the JSON content into the bundled `main.js` at build time. This
 * **eliminates drift by construction**: the JSON file is the single source of
 * truth, consumed both by:
 *   - CDN clients (raw.githubusercontent.com/VibeBrains/VibeIDE/main/resources/model-quirks.json),
 *   - bundled IDE fallback (this module).
 *
 * No separate sync step, no drift-check script needed.
 *
 * The earlier v0.13.7 approach (duplicate TS literal) was replaced for exactly
 * this reason — two sources of truth always drift in practice.
 */

import type { ModelQuirksCatalog } from './modelQuirksTypes.js';

/**
 * Resolve the bundled model-quirks catalog. The JSON is import-attribute loaded
 * (not a static `import`) so the bundled data still inlines at build time while
 * keeping the consuming `common/` layer free of a non-`.js` relative import.
 *
 * The default export of a JSON module is typed loosely by resolveJsonModule
 * (structural types that don't carry our `ToolCallFormat` enum); we cast through
 * `unknown` to retain compile-time safety on the consumer side — actual structural
 * correctness is enforced at runtime by `validateCatalog()` in `modelQuirksService.ts`.
 */
export async function loadBundledCatalog(): Promise<ModelQuirksCatalog> {
	const mod = await import('../../../../../../../resources/model-quirks.json', { with: { type: 'json' } });
	return mod.default as unknown as ModelQuirksCatalog;
}
