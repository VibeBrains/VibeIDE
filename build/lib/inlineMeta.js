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
Object.defineProperty(exports, "__esModule", { value: true });
exports.inlineMeta = inlineMeta;
const es = __importStar(require("event-stream"));
const path = __importStar(require("path"));
const packageJsonMarkerId = 'BUILD_INSERT_PACKAGE_CONFIGURATION';
// TODO in order to inline `product.json`, more work is
// needed to ensure that we cover all cases where modifications
// are done to the product configuration during build. There are
// at least 2 more changes that kick in very late:
// - a `darwinUniversalAssetId` is added in`create-universal-app.ts`
// - a `target` is added in `gulpfile.vscode.win32.js`
// const productJsonMarkerId = 'BUILD_INSERT_PRODUCT_CONFIGURATION';
function inlineMeta(result, ctx) {
    return result.pipe(es.through(function (file) {
        if (matchesFile(file, ctx)) {
            let content = file.contents.toString();
            let markerFound = false;
            const packageMarker = `${packageJsonMarkerId}:"${packageJsonMarkerId}"`; // this needs to be the format after esbuild has processed the file (e.g. double quotes)
            if (content.includes(packageMarker)) {
                content = content.replace(packageMarker, JSON.stringify(JSON.parse(ctx.packageJsonFn())).slice(1, -1) /* trim braces */);
                markerFound = true;
            }
            // const productMarker = `${productJsonMarkerId}:"${productJsonMarkerId}"`; // this needs to be the format after esbuild has processed the file (e.g. double quotes)
            // if (content.includes(productMarker)) {
            // 	content = content.replace(productMarker, JSON.stringify(JSON.parse(ctx.productJsonFn())).slice(1, -1) /* trim braces */);
            // 	markerFound = true;
            // }
            if (markerFound) {
                file.contents = Buffer.from(content);
            }
        }
        this.emit('data', file);
    }));
}
function matchesFile(file, ctx) {
    for (const targetPath of ctx.targetPaths) {
        if (file.basename === path.basename(targetPath)) { // TODO would be nicer to figure out root relative path to not match on false positives
            return true;
        }
    }
    return false;
}
//# sourceMappingURL=inlineMeta.js.map