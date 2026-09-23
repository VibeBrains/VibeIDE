/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * OCR language data shipped with the app, so a scanned PDF is read without a network.
 *
 * The recognizer (tesseract.js) looks for `<lang>.traineddata` in its cache first and downloads only
 * what is missing. The shipped languages are therefore copied into that cache, instead of pointing
 * `langPath` at them: a language we do not ship keeps downloading as before.
 *
 * Only the LSTM variant ships — the one tesseract.js reads by default (`4.0.0_best_int`, about 3 MB per
 * language); the legacy one next to it in the package (about 10 MB per language) is cut from the build.
 */

import { AppResourcePath, appNodeModulesPath } from '../../../../../base/common/network.js';

/** Russian and English: the languages of the product and of most of its users' documents. */
export const OCR_BUNDLED_LANGUAGES: readonly string[] = ['eng', 'rus'];

/** The data variant tesseract.js loads in its default LSTM-only mode. */
export const OCR_BUNDLED_VARIANT = '4.0.0_best_int';

/** A tesseract language code: letters and underscores (`chi_sim`), nothing that could leave a folder. */
const LANGUAGE_CODE = /^[a-z]{3}(?:_[a-z]+)?$/i;

/** `rus+eng` → `['rus', 'eng']`: the codes tesseract combines with `+`, each once, invalid ones dropped. */
export function ocrLanguagesOf(spec: string): string[] {
	return [...new Set(spec.split('+').map(code => code.trim()).filter(code => LANGUAGE_CODE.test(code)))];
}

/** Where the app carries a language's data, or nothing for a language it does not ship. */
export function bundledTrainedDataPath(language: string): AppResourcePath | undefined {
	return OCR_BUNDLED_LANGUAGES.includes(language)
		? `${appNodeModulesPath}/@tesseract.js-data/${language}/${OCR_BUNDLED_VARIANT}/${language}.traineddata.gz` as AppResourcePath
		: undefined;
}
