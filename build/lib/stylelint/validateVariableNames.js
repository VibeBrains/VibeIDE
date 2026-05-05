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
exports.getVariableNameValidator = getVariableNameValidator;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const RE_VAR_PROP = /var\(\s*(--([\w\-\.]+))/g;
let knownVariables;
function getKnownVariableNames() {
    if (!knownVariables) {
        const knownVariablesFileContent = fs.readFileSync(path.join(__dirname, './vscode-known-variables.json'), 'utf8').toString();
        const knownVariablesInfo = JSON.parse(knownVariablesFileContent);
        knownVariables = new Set([...knownVariablesInfo.colors, ...knownVariablesInfo.others]);
    }
    return knownVariables;
}
const iconVariable = /^--vscode-icon-.+-(content|font-family)$/;
function getVariableNameValidator() {
    const allVariables = getKnownVariableNames();
    return (value, report) => {
        RE_VAR_PROP.lastIndex = 0; // reset lastIndex just to be sure
        let match;
        while (match = RE_VAR_PROP.exec(value)) {
            const variableName = match[1];
            if (variableName && !allVariables.has(variableName) && !iconVariable.test(variableName)) {
                report(variableName);
            }
        }
    };
}
//# sourceMappingURL=validateVariableNames.js.map