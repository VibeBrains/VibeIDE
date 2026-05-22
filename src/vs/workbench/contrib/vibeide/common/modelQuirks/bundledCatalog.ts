/*--------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------*/

/**
 * In-tree fallback for the model-quirks catalog.
 *
 * Re-exports `resources/model-quirks.json` directly via a TypeScript `import` —
 * `tsconfig.json:resolveJsonModule: true` is enabled, esbuild's `.json` loader
 * inlines the JSON content into the bundled `main.js` at build time. This
 * **eliminates drift by construction**: the JSON file is the single source of
 * truth, consumed both by:
 *   - CDN clients (raw.githubusercontent.com/VibeIDETeam/VibeIDE/main/resources/model-quirks.json),
 *   - bundled IDE fallback (this module).
 *
 * No separate sync step, no drift-check script needed.
 *
 * The earlier v0.13.7 approach (duplicate TS literal) was replaced for exactly
 * this reason — two sources of truth always drift in practice.
 */

import quirksCatalog from '../../../../../../../resources/model-quirks.json' with { type: 'json' }
import type { ModelQuirksCatalog } from './modelQuirksTypes.js'

// `quirksCatalog` is typed as `any` because resolveJsonModule infers structural
// types that don't carry our `ToolCallFormat` enum. We cast through `unknown` to
// retain compile-time safety on the consumer side — actual structural correctness
// is enforced at runtime by `validateCatalog()` in `modelQuirksService.ts`.
export const BUNDLED_CATALOG: ModelQuirksCatalog = quirksCatalog as unknown as ModelQuirksCatalog
