/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *
 * Prints Windows Electron binary name derived from product.json (nameShort + ".exe").
 * Used by code.bat / run-dev.bat because nameShort changes with VibeIDE branding.
 *--------------------------------------------------------------------------------------------*/
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const product = JSON.parse(readFileSync(join(repoRoot, 'product.json'), 'utf8'));
process.stdout.write(String(product.nameShort) + '.exe');
