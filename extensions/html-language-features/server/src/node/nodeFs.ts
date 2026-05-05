/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FileSystemProvider } from '../requests.js';
import { URI as Uri } from 'vscode-uri';

import * as fs from 'fs';
import * as cssLs from 'vscode-css-languageservice';

export function getNodeFileFS(): FileSystemProvider {
	function ensureFileUri(location: string) {
		if (!location.startsWith('file:')) {
			throw new Error('fileSystemProvider can only handle file URLs');
		}
	}
	return {
		stat(location: string) {
			ensureFileUri(location);
			return new Promise((c, e) => {
				const uri = Uri.parse(location);
				fs.stat(uri.fsPath, (err, stats) => {
					if (err) {
						if (err.code === 'ENOENT') {
							return c({ type: cssLs.FileType.Unknown, ctime: -1, mtime: -1, size: -1 });
						} else {
							return e(err);
						}
					}

					let type = cssLs.FileType.Unknown;
					if (stats.isFile()) {
						type = cssLs.FileType.File;
					} else if (stats.isDirectory()) {
						type = cssLs.FileType.Directory;
					} else if (stats.isSymbolicLink()) {
						type = cssLs.FileType.SymbolicLink;
					}

					c({
						type,
						ctime: stats.ctime.getTime(),
						mtime: stats.mtime.getTime(),
						size: stats.size
					});
				});
			});
		},
		readDirectory(location: string) {
			ensureFileUri(location);
			return new Promise((c, e) => {
				const path = Uri.parse(location).fsPath;

				fs.readdir(path, { withFileTypes: true }, (err, children) => {
					if (err) {
						return e(err);
					}
					c(children.map(stat => {
						if (stat.isSymbolicLink()) {
							return [stat.name, cssLs.FileType.SymbolicLink];
						} else if (stat.isDirectory()) {
							return [stat.name, cssLs.FileType.Directory];
						} else if (stat.isFile()) {
							return [stat.name, cssLs.FileType.File];
						} else {
							return [stat.name, cssLs.FileType.Unknown];
						}
					}));
				});
			});
		}
	};
}
