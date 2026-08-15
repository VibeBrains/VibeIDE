/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { EventEmitter } from 'events';
EventEmitter.defaultMaxListeners = 100;

import glob from 'glob';
import { createRequire } from 'node:module';
import { monacoTypecheckTask /* , monacoTypecheckWatchTask */ } from './gulpfile.editor.ts';
import { compileExtensionMediaTask, compileExtensionsTask, watchExtensionsTask } from './gulpfile.extensions.ts';
import * as compilation from './lib/compilation.ts';
import { gulp } from './lib/gulp/facade.ts';
import * as task from './lib/gulp/task.ts';
import * as util from './lib/util.ts';
import { buildVibeideBrowserReactTask } from './lib/vibeideReactBuild.ts';

// Extension point names
task.task(compilation.compileExtensionPointNamesTask);

const require = createRequire(import.meta.url);

// API proposal names
task.task(compilation.compileApiProposalNamesTask);
task.task(compilation.watchApiProposalNamesTask);

// Copy VS CSS into out/ so ESM `import './media/foo.css'` + dev import maps resolve (see cssDevService + workbench.ts).
// `removeBOM: false`: vinyl-fs strips a UTF-8 BOM by default, and this copy runs LAST in the transpile
// series — so without it the encoding test fixture `some_utf8.css` lands in out/ without its BOM and
// `detectBOM UTF-8` fails. Keep the bytes verbatim on copy. (The option is `removeBOM`, not `stripBOM`.)
const copyVsCssTask = task.define('copy-vs-css', () => gulp.src('src/vs/**/*.css', { base: 'src', removeBOM: false }).pipe(gulp.dest('out')));

// SWC Client Transpile
const transpileClientSWCTask = task.define('transpile-client-esbuild', task.series(util.rimraf('out'), compilation.transpileTask('src', 'out', true), copyVsCssTask));
task.task(transpileClientSWCTask);

// Transpile only
const transpileClientTask = task.define('transpile-client', task.series(util.rimraf('out'), compilation.transpileTask('src', 'out'), copyVsCssTask));
task.task(transpileClientTask);

// Fast compile for development time (includes NLS metadata in out/ for localized UI — build flag enables nls() transform)
const compileClientTask = task.define('compile-client', task.series(util.rimraf('out'), compilation.copyCodiconsTask, compilation.compileApiProposalNamesTask, compilation.compileExtensionPointNamesTask, compilation.compileTask('src', 'out', true, { disableMangle: true, preserveEnglish: true }), copyVsCssTask));
task.task(compileClientTask);

const watchClientTask = task.define('watch-client', task.parallel(compilation.watchTypeCheckTask('src'), compilation.watchApiProposalNamesTask, compilation.watchExtensionPointNamesTask, compilation.watchCodiconsTask));
task.task(watchClientTask);

// All (VibeIDE React bundles in react/out are gitignored — build them before client typecheck/compile)
const _compileTask = task.define('compile', task.series(
	buildVibeideBrowserReactTask,
	task.parallel(monacoTypecheckTask, compileClientTask, compileExtensionsTask, compileExtensionMediaTask)
));
task.task(_compileTask);

task.task(task.define('watch', task.parallel(/* monacoTypecheckWatchTask, */ watchClientTask, watchExtensionsTask)));

// Default
task.task('default', _compileTask);

process.on('unhandledRejection', (reason, p) => {
	console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
	process.exit(1);
});

// Load all the gulpfiles only if running tasks other than the editor tasks
glob.sync('gulpfile.*.ts', { cwd: import.meta.dirname })
	.forEach(f => {
		return require(`./${f}`);
	});
