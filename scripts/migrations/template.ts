/**
 * VibeIDE Migration Script Template
 *
 * Copy this file and rename to: v{FROM}-to-v{TO}.ts
 * Example: v0.1.0-to-v0.2.0.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const FROM_VERSION = '0.1.0';
const TO_VERSION = '0.2.0';

interface MigrationResult {
	success: boolean;
	filesUpdated: string[];
	errors: string[];
}

/**
 * Main migration function.
 * Called by vibeMigrationService.ts at IDE startup.
 * Must be idempotent — safe to run multiple times.
 */
export async function migrate(workspacePath: string): Promise<MigrationResult> {
	const result: MigrationResult = { success: true, filesUpdated: [], errors: [] };
	const vibePath = path.join(workspacePath, '.vibe');

	console.log(`[Migration ${FROM_VERSION} → ${TO_VERSION}] Starting...`);

	// Example: migrate constraints.json schema
	const constraintsPath = path.join(vibePath, 'constraints.json');
	if (fs.existsSync(constraintsPath)) {
		try {
			const raw = fs.readFileSync(constraintsPath, 'utf-8');
			const data = JSON.parse(raw);

			// Skip if already migrated
			if (data.vibeVersion === TO_VERSION) {
				console.log(`[Migration] ${constraintsPath} already at version ${TO_VERSION}`);
			} else {
				// Perform migration
				// Example: rename old field
				// if (data.oldField) { data.newField = data.oldField; delete data.oldField; }

				data.vibeVersion = TO_VERSION;
				fs.writeFileSync(constraintsPath, JSON.stringify(data, null, '\t') + '\n');
				result.filesUpdated.push(constraintsPath);
				console.log(`[Migration] Updated ${constraintsPath}`);
			}
		} catch (e) {
			result.errors.push(`Failed to migrate ${constraintsPath}: ${e}`);
			result.success = false;
		}
	}

	console.log(`[Migration ${FROM_VERSION} → ${TO_VERSION}] Done. Updated: ${result.filesUpdated.length}, Errors: ${result.errors.length}`);
	return result;
}

// CLI usage: node v0.1.0-to-v0.2.0.js --workspace /path/to/workspace
if (require.main === module) {
	const workspaceArg = process.argv.find(a => a.startsWith('--workspace='))?.split('=')[1]
		|| process.argv[process.argv.indexOf('--workspace') + 1];
	if (!workspaceArg) {
		console.error('Usage: node migration.js --workspace /path/to/workspace');
		process.exit(1);
	}
	migrate(workspaceArg).then(r => {
		if (!r.success) { console.error('Migration failed:', r.errors); process.exit(1); }
	});
}
