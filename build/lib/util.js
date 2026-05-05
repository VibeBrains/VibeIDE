"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.VinylStat = void 0;
exports.incremental = incremental;
exports.debounce = debounce;
exports.fixWin32DirectoryPermissions = fixWin32DirectoryPermissions;
exports.setExecutableBit = setExecutableBit;
exports.toFileUri = toFileUri;
exports.skipDirectories = skipDirectories;
exports.cleanNodeModules = cleanNodeModules;
exports.loadSourcemaps = loadSourcemaps;
exports.stripSourceMappingURL = stripSourceMappingURL;
exports.$if = $if;
exports.appendOwnPathSourceURL = appendOwnPathSourceURL;
exports.rewriteSourceMappingURL = rewriteSourceMappingURL;
exports.rimraf = rimraf;
exports.rreddir = rreddir;
exports.ensureDir = ensureDir;
exports.rebase = rebase;
exports.filter = filter;
exports.streamToPromise = streamToPromise;
exports.getElectronVersion = getElectronVersion;
const es = __importStar(require("event-stream"));
const debounce_1 = __importDefault(require("debounce"));
const gulp_filter_1 = __importDefault(require("gulp-filter"));
const gulp_rename_1 = __importDefault(require("gulp-rename"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const url_1 = require("url");
const ternary_stream_1 = __importDefault(require("ternary-stream"));
const root = path_1.default.dirname(path_1.default.dirname(__dirname));
// Use require for rimraf 2.2.8 (CommonJS module, no default export)
const rimrafModule = require('rimraf');
const NoCancellationToken = { isCancellationRequested: () => false };
function incremental(streamProvider, initial, supportsCancellation) {
    const input = es.through();
    const output = es.through();
    let state = 'idle';
    let buffer = Object.create(null);
    const token = !supportsCancellation ? undefined : { isCancellationRequested: () => Object.keys(buffer).length > 0 };
    const run = (input, isCancellable) => {
        state = 'running';
        const stream = !supportsCancellation ? streamProvider() : streamProvider(isCancellable ? token : NoCancellationToken);
        input
            .pipe(stream)
            .pipe(es.through(undefined, () => {
            state = 'idle';
            eventuallyRun();
        }))
            .pipe(output);
    };
    if (initial) {
        run(initial, false);
    }
    const eventuallyRun = (0, debounce_1.default)(() => {
        const paths = Object.keys(buffer);
        if (paths.length === 0) {
            return;
        }
        const data = paths.map(path => buffer[path]);
        buffer = Object.create(null);
        run(es.readArray(data), true);
    }, 500);
    input.on('data', (f) => {
        buffer[f.path] = f;
        if (state === 'idle') {
            eventuallyRun();
        }
    });
    return es.duplex(input, output);
}
function debounce(task, duration = 500) {
    const input = es.through();
    const output = es.through();
    let state = 'idle';
    const run = () => {
        state = 'running';
        task()
            .pipe(es.through(undefined, () => {
            const shouldRunAgain = state === 'stale';
            state = 'idle';
            if (shouldRunAgain) {
                eventuallyRun();
            }
        }))
            .pipe(output);
    };
    run();
    const eventuallyRun = (0, debounce_1.default)(() => run(), duration);
    input.on('data', () => {
        if (state === 'idle') {
            eventuallyRun();
        }
        else {
            state = 'stale';
        }
    });
    return es.duplex(input, output);
}
function fixWin32DirectoryPermissions() {
    if (!/win32/.test(process.platform)) {
        return es.through();
    }
    return es.mapSync(f => {
        if (f.stat && f.stat.isDirectory && f.stat.isDirectory()) {
            f.stat.mode = 16877;
        }
        return f;
    });
}
function setExecutableBit(pattern) {
    const setBit = es.mapSync(f => {
        if (!f.stat) {
            const stat = { isFile() { return true; }, mode: 0 };
            f.stat = stat;
        }
        f.stat.mode = /* 100755 */ 33261;
        return f;
    });
    if (!pattern) {
        return setBit;
    }
    const input = es.through();
    const filter = (0, gulp_filter_1.default)(pattern, { restore: true });
    const output = input
        .pipe(filter)
        .pipe(setBit)
        .pipe(filter.restore);
    return es.duplex(input, output);
}
function toFileUri(filePath) {
    const match = filePath.match(/^([a-z])\:(.*)$/i);
    if (match) {
        filePath = '/' + match[1].toUpperCase() + ':' + match[2];
    }
    return 'file://' + filePath.replace(/\\/g, '/');
}
function skipDirectories() {
    return es.mapSync(f => {
        if (!f.isDirectory()) {
            return f;
        }
    });
}
function cleanNodeModules(rulePath) {
    const rules = fs_1.default.readFileSync(rulePath, 'utf8')
        .split(/\r?\n/g)
        .map(line => line.trim())
        .filter(line => line && !/^#/.test(line));
    const excludes = rules.filter(line => !/^!/.test(line)).map(line => `!**/node_modules/${line}`);
    const includes = rules.filter(line => /^!/.test(line)).map(line => `**/node_modules/${line.substr(1)}`);
    const input = es.through();
    const output = es.merge(input.pipe((0, gulp_filter_1.default)(['**', ...excludes])), input.pipe((0, gulp_filter_1.default)(includes)));
    return es.duplex(input, output);
}
function loadSourcemaps() {
    const input = es.through();
    const output = input
        .pipe(es.map((f, cb) => {
        if (f.sourceMap) {
            cb(undefined, f);
            return;
        }
        if (!f.contents) {
            cb(undefined, f);
            return;
        }
        const contents = f.contents.toString('utf8');
        const reg = /\/\/# sourceMappingURL=(.*)$/g;
        let lastMatch = null;
        let match = null;
        while (match = reg.exec(contents)) {
            lastMatch = match;
        }
        if (!lastMatch) {
            f.sourceMap = {
                version: '3',
                names: [],
                mappings: '',
                sources: [f.relative.replace(/\\/g, '/')],
                sourcesContent: [contents]
            };
            cb(undefined, f);
            return;
        }
        f.contents = Buffer.from(contents.replace(/\/\/# sourceMappingURL=(.*)$/g, ''), 'utf8');
        fs_1.default.readFile(path_1.default.join(path_1.default.dirname(f.path), lastMatch[1]), 'utf8', (err, contents) => {
            if (err) {
                return cb(err);
            }
            f.sourceMap = JSON.parse(contents);
            cb(undefined, f);
        });
    }));
    return es.duplex(input, output);
}
function stripSourceMappingURL() {
    const input = es.through();
    const output = input
        .pipe(es.mapSync(f => {
        const contents = f.contents.toString('utf8');
        f.contents = Buffer.from(contents.replace(/\n\/\/# sourceMappingURL=(.*)$/gm, ''), 'utf8');
        return f;
    }));
    return es.duplex(input, output);
}
/** Splits items in the stream based on the predicate, sending them to onTrue if true, or onFalse otherwise */
function $if(test, onTrue, onFalse = es.through()) {
    if (typeof test === 'boolean') {
        return test ? onTrue : onFalse;
    }
    return (0, ternary_stream_1.default)(test, onTrue, onFalse);
}
/** Operator that appends the js files' original path a sourceURL, so debug locations map */
function appendOwnPathSourceURL() {
    const input = es.through();
    const output = input
        .pipe(es.mapSync(f => {
        if (!(f.contents instanceof Buffer)) {
            throw new Error(`contents of ${f.path} are not a buffer`);
        }
        f.contents = Buffer.concat([f.contents, Buffer.from(`\n//# sourceURL=${(0, url_1.pathToFileURL)(f.path)}`)]);
        return f;
    }));
    return es.duplex(input, output);
}
function rewriteSourceMappingURL(sourceMappingURLBase) {
    const input = es.through();
    const output = input
        .pipe(es.mapSync(f => {
        const contents = f.contents.toString('utf8');
        const str = `//# sourceMappingURL=${sourceMappingURLBase}/${path_1.default.dirname(f.relative).replace(/\\/g, '/')}/$1`;
        f.contents = Buffer.from(contents.replace(/\n\/\/# sourceMappingURL=(.*)$/gm, str));
        return f;
    }));
    return es.duplex(input, output);
}
function rimraf(dir) {
    const result = () => new Promise((c, e) => {
        let retries = 0;
        const retry = () => {
            rimrafModule(dir, { maxBusyTries: 1 }, (err) => {
                if (!err) {
                    return c();
                }
                if (err.code === 'ENOTEMPTY' && ++retries < 5) {
                    return setTimeout(() => retry(), 10);
                }
                return e(err);
            });
        };
        retry();
    });
    result.taskName = `clean-${path_1.default.basename(dir).toLowerCase()}`;
    return result;
}
function _rreaddir(dirPath, prepend, result) {
    const entries = fs_1.default.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory()) {
            _rreaddir(path_1.default.join(dirPath, entry.name), `${prepend}/${entry.name}`, result);
        }
        else {
            result.push(`${prepend}/${entry.name}`);
        }
    }
}
function rreddir(dirPath) {
    const result = [];
    _rreaddir(dirPath, '', result);
    return result;
}
function ensureDir(dirPath) {
    if (fs_1.default.existsSync(dirPath)) {
        return;
    }
    ensureDir(path_1.default.dirname(dirPath));
    fs_1.default.mkdirSync(dirPath);
}
function rebase(count) {
    return (0, gulp_rename_1.default)(f => {
        const parts = f.dirname ? f.dirname.split(/[\/\\]/) : [];
        f.dirname = parts.slice(count).join(path_1.default.sep);
    });
}
function filter(fn) {
    const result = es.through(function (data) {
        if (fn(data)) {
            this.emit('data', data);
        }
        else {
            result.restore.push(data);
        }
    });
    result.restore = es.through();
    return result;
}
function streamToPromise(stream) {
    return new Promise((c, e) => {
        stream.on('error', err => e(err));
        stream.on('end', () => c());
    });
}
function getElectronVersion() {
    const npmrc = fs_1.default.readFileSync(path_1.default.join(root, '.npmrc'), 'utf8');
    const electronVersion = /^target="(.*)"$/m.exec(npmrc)[1];
    const msBuildId = /^ms_build_id="(.*)"$/m.exec(npmrc)[1];
    return { electronVersion, msBuildId };
}
class VinylStat {
    dev;
    ino;
    mode;
    nlink;
    uid;
    gid;
    rdev;
    size;
    blksize;
    blocks;
    atimeMs;
    mtimeMs;
    ctimeMs;
    birthtimeMs;
    atime;
    mtime;
    ctime;
    birthtime;
    constructor(stat) {
        this.dev = stat.dev ?? 0;
        this.ino = stat.ino ?? 0;
        this.mode = stat.mode ?? 0;
        this.nlink = stat.nlink ?? 0;
        this.uid = stat.uid ?? 0;
        this.gid = stat.gid ?? 0;
        this.rdev = stat.rdev ?? 0;
        this.size = stat.size ?? 0;
        this.blksize = stat.blksize ?? 0;
        this.blocks = stat.blocks ?? 0;
        this.atimeMs = stat.atimeMs ?? 0;
        this.mtimeMs = stat.mtimeMs ?? 0;
        this.ctimeMs = stat.ctimeMs ?? 0;
        this.birthtimeMs = stat.birthtimeMs ?? 0;
        this.atime = stat.atime ?? new Date(0);
        this.mtime = stat.mtime ?? new Date(0);
        this.ctime = stat.ctime ?? new Date(0);
        this.birthtime = stat.birthtime ?? new Date(0);
    }
    isFile() { return true; }
    isDirectory() { return false; }
    isBlockDevice() { return false; }
    isCharacterDevice() { return false; }
    isSymbolicLink() { return false; }
    isFIFO() { return false; }
    isSocket() { return false; }
}
exports.VinylStat = VinylStat;
//# sourceMappingURL=util.js.map