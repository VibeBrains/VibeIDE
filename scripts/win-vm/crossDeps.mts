/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Aligns shipped platform packages with the build target when the host arch differs (ARM64 host, x64 target)
//
// npm picks optional platform packages by the HOST cpu: on an ARM64 machine it installs `*-win32-arm64`
// or, when a package has no ARM64 variant, nothing at all. Native modules built from source follow
// `npm_config_arch`, prebuilt ones do not. For every production entry of the lock:
//   a win32 package for the target cpu that is missing — is fetched and unpacked;
//   a win32 package for the host cpu only, installed in place of that missing sibling — is removed.
// Dev entries are left alone: build tools (esbuild, tsgo, rollup) must stay native to the host
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const target = process.env.npm_config_arch;
const host = process.arch;
const dir = process.argv[2] ?? '.';
if (!target || target === host) {
	console.log(`crossDeps: host ${host}, target ${target ?? host} — nothing to align`);
	process.exit(0);
}
interface LockEntry {
	readonly version: string;
	readonly dev?: boolean;
	readonly os?: readonly string[];
	readonly cpu?: readonly string[];
}

const lock: Record<string, LockEntry> = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8')).packages ?? {};
const isWin = (e: LockEntry) => !e.os || e.os.includes('win32');
const prodPlatform = Object.entries(lock).filter(([p, e]) => p.startsWith('node_modules/') && !e.dev && Array.isArray(e.cpu) && e.os && isWin(e));
const added: string[] = [];
for (const [p, e] of prodPlatform) {
	if (!e.cpu!.includes(target) || fs.existsSync(path.join(dir, p, 'package.json'))) {
		continue;
	}
	const name = p.slice(p.lastIndexOf('node_modules/') + 'node_modules/'.length);
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crossdeps-'));
	const tarball = cp.execSync(`npm pack ${name}@${e.version} --silent --pack-destination "${tmp}"`, { encoding: 'utf8', env: { ...process.env, npm_config_arch: '' } }).trim().split(/\r?\n/).pop()!;
	fs.mkdirSync(path.join(dir, p), { recursive: true });
	cp.execSync(`tar -xf "${path.join(tmp, tarball)}" --strip-components=1 -C "${path.join(dir, p)}"`);
	fs.rmSync(tmp, { recursive: true, force: true });
	added.push(name);
	console.log(`crossDeps: + ${name}@${e.version} (${target})`);
}
for (const [p, e] of prodPlatform) {
	const name = p.slice(p.lastIndexOf('node_modules/') + 'node_modules/'.length);
	const sibling = name.replace(host, target);
	if (e.cpu!.length === 1 && e.cpu![0] === host && sibling !== name && added.includes(sibling) && fs.existsSync(path.join(dir, p))) {
		fs.rmSync(path.join(dir, p), { recursive: true, force: true });
		console.log(`crossDeps: - ${name} (${host}, installed in place of ${sibling})`);
	}
}
console.log(`crossDeps: ${dir} aligned to ${target}`);
