/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { generateUuid } from '../../../../../base/common/uuid.js';
import { endsWithAnyPrefixOf, SurroundingsRemover } from '../../common/helpers/extractCodeFromResult.js';
import { stripStandaloneThinkDelimiters } from '../../common/helpers/stripThinkDelimiters.js';
import { availableTools, InternalToolInfo } from '../../common/prompt/prompts.js';
import { PARAM_ALIASES_BY_TOOL, TOOL_NAME_ALIASES } from '../../common/prompt/toolAliases.js';
import { OnFinalMessage, OnText, RawToolCallObj, RawToolParamsObj } from '../../common/sendLLMMessageTypes.js';
import { ToolName, ToolParamName } from '../../common/toolsServiceTypes.js';
import { ChatMode } from '../../common/vibeideSettingsTypes.js';
import { normalizeAlternativeToolSyntax, SELF_CLOSING_PARTIAL_RE, stripUnclaimedToolTags, VENDOR_NAMESPACED_SUFFIXES, VENDOR_WRAPPER_NAMES } from '../../common/xmlToolNormalize.js';


// =============== reasoning ===============

// could simplify this - this assumes we can never add a tag without committing it to the user's screen, but that's not true
export const extractReasoningWrapper = (
	onText: OnText, onFinalMessage: OnFinalMessage, thinkTags: [string, string]
): { newOnText: OnText; newOnFinalMessage: OnFinalMessage } => {
	let latestAddIdx = 0; // exclusive index in fullText_
	let foundTag1 = false;
	let foundTag2 = false;

	let fullTextSoFar = '';
	let fullReasoningSoFar = '';


	if (!thinkTags[0] || !thinkTags[1]) { throw new Error(`thinkTags must not be empty if provided. Got ${JSON.stringify(thinkTags)}.`); }

	const onText_ = onText;
	onText = (params) => {
		onText_(params);
	};

	const newOnText: OnText = ({ fullText: fullText_, ...p }) => {

		// until found the first think tag, keep adding to fullText
		if (!foundTag1) {
			const endsWithTag1 = endsWithAnyPrefixOf(fullText_, thinkTags[0]);
			if (endsWithTag1) {
				// console.log('endswith1', { fullTextSoFar, fullReasoningSoFar, fullText_ })
				// wait until we get the full tag or know more
				return;
			}
			// if found the first tag
			const tag1Index = fullText_.indexOf(thinkTags[0]);
			if (tag1Index !== -1) {
				// console.log('tag1Index !==1', { tag1Index, fullTextSoFar, fullReasoningSoFar, thinkTags, fullText_ })
				foundTag1 = true;
				// Add text before the tag to fullTextSoFar
				fullTextSoFar += fullText_.substring(0, tag1Index);
				// Update latestAddIdx to after the first tag
				latestAddIdx = tag1Index + thinkTags[0].length;
				onText({ ...p, fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar });
				return;
			}

			// console.log('adding to text A', { fullTextSoFar, fullReasoningSoFar })
			// add the text to fullText
			fullTextSoFar = fullText_;
			latestAddIdx = fullText_.length;
			onText({ ...p, fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar });
			return;
		}

		// at this point, we found <tag1>

		// until found the second think tag, keep adding to fullReasoning
		if (!foundTag2) {
			const endsWithTag2 = endsWithAnyPrefixOf(fullText_, thinkTags[1]);
			if (endsWithTag2 && endsWithTag2 !== thinkTags[1]) { // if ends with any partial part (full is fine)
				// console.log('endsWith2', { fullTextSoFar, fullReasoningSoFar })
				// wait until we get the full tag or know more
				return;
			}

			// if found the second tag
			const tag2Index = fullText_.indexOf(thinkTags[1], latestAddIdx);
			if (tag2Index !== -1) {
				// console.log('tag2Index !== -1', { fullTextSoFar, fullReasoningSoFar })
				foundTag2 = true;
				// Add everything between first and second tag to reasoning
				fullReasoningSoFar += fullText_.substring(latestAddIdx, tag2Index);
				// Update latestAddIdx to after the second tag
				latestAddIdx = tag2Index + thinkTags[1].length;
				onText({ ...p, fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar });
				return;
			}

			// add the text to fullReasoning (content after first tag but before second tag)
			// console.log('adding to text B', { fullTextSoFar, fullReasoningSoFar })

			// If we have more text than we've processed, add it to reasoning
			if (fullText_.length > latestAddIdx) {
				fullReasoningSoFar += fullText_.substring(latestAddIdx);
				latestAddIdx = fullText_.length;
			}

			onText({ ...p, fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar });
			return;
		}

		// at this point, we found <tag2> - content after the second tag is normal text
		// console.log('adding to text C', { fullTextSoFar, fullReasoningSoFar })

		// Add any new text after the closing tag to fullTextSoFar
		if (fullText_.length > latestAddIdx) {
			fullTextSoFar += fullText_.substring(latestAddIdx);
			latestAddIdx = fullText_.length;
		}

		onText({ ...p, fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar });
	};


	const getOnFinalMessageParams = () => {
		const fullText_ = fullTextSoFar;
		const tag1Idx = fullText_.indexOf(thinkTags[0]);
		const tag2Idx = fullText_.indexOf(thinkTags[1]);
		if (tag1Idx === -1) { return { fullText: fullText_, fullReasoning: '' }; } // never started reasoning
		if (tag2Idx === -1) { return { fullText: '', fullReasoning: fullText_ }; } // never stopped reasoning

		const fullReasoning = fullText_.substring(tag1Idx + thinkTags[0].length, tag2Idx);
		const fullText = fullText_.substring(0, tag1Idx) + fullText_.substring(tag2Idx + thinkTags[1].length, Infinity);

		return { fullText, fullReasoning };
	};

	const newOnFinalMessage: OnFinalMessage = (params) => {

		// treat like just got text before calling onFinalMessage (or else we sometimes miss the final chunk that's new to finalMessage)
		newOnText({ ...params });

		const { fullText, fullReasoning } = getOnFinalMessageParams();
		onFinalMessage({ ...params, fullText, fullReasoning });
	};

	return { newOnText, newOnFinalMessage };
};


/**
 * Remove every complete `<open>…<close>` block from `raw`. A trailing UNCLOSED `<open>` (its
 * `<close>` hasn't streamed yet) hides everything from that open onward, so a half-streamed
 * think block never flashes in the UI. Pure / deterministic.
 */
const stripThinkBlocks = (raw: string, open: string, close: string): string => {
	let out = '';
	let i = 0;
	while (i < raw.length) {
		const openIdx = raw.indexOf(open, i);
		if (openIdx === -1) { out += raw.slice(i); break; }
		out += raw.slice(i, openIdx);
		const closeIdx = raw.indexOf(close, openIdx + open.length);
		if (closeIdx === -1) { break; } // unclosed (still streaming) → hide the tail
		i = closeIdx + close.length;
	}
	return out;
};

/**
 * STRIP-ONLY think-tag handler for models that emit a NATIVE reasoning channel AND duplicate
 * the same chain-of-thought as inline `<think>…</think>` in the content (observed: MiniMax-M3).
 *
 * Unlike {@link extractReasoningWrapper}, this NEVER touches `fullReasoning` — the native
 * `reasoning-delta` is authoritative and must survive to the saved message (fold + export).
 * It only removes the duplicate tags from `fullText` so they don't leak into the answer body.
 * (extractReasoningWrapper would re-derive — and on interleave with native deltas, clobber —
 * the reasoning, which dropped both the reasoning and the post-tag answer; see model-quirks.)
 */
export const stripThinkTagsWrapper = (
	onText: OnText, onFinalMessage: OnFinalMessage, thinkTags: [string, string]
): { newOnText: OnText; newOnFinalMessage: OnFinalMessage } => {
	const [open, close] = thinkTags;
	const newOnText: OnText = ({ fullText, ...p }) => {
		onText({ ...p, fullText: stripThinkBlocks(fullText, open, close) });
	};
	const newOnFinalMessage: OnFinalMessage = ({ fullText, ...p }) => {
		onFinalMessage({ ...p, fullText: stripThinkBlocks(fullText, open, close) });
	};
	return { newOnText, newOnFinalMessage };
};


/**
 * UNIVERSAL safety net (all models): drop orphan reasoning-delimiter lines that leak into content —
 * e.g. a lone `</think>` with no matching `<think>`, emitted by native-reasoning models proxied
 * through aggregators. The block/pair handlers above can't catch a single dangling tag, so without
 * this the marker shows in the answer and is replayed to the model next turn. Strip logic lives in
 * `common/helpers/stripThinkDelimiters` (pure, unit-tested); only whole-line delimiters are removed.
 */
export const stripStandaloneThinkDelimitersWrapper = (
	onText: OnText, onFinalMessage: OnFinalMessage
): { newOnText: OnText; newOnFinalMessage: OnFinalMessage } => {
	const newOnText: OnText = ({ fullText, ...p }) => {
		onText({ ...p, fullText: stripStandaloneThinkDelimiters(fullText) });
	};
	const newOnFinalMessage: OnFinalMessage = ({ fullText, ...p }) => {
		onFinalMessage({ ...p, fullText: stripStandaloneThinkDelimiters(fullText) });
	};
	return { newOnText, newOnFinalMessage };
};


// =============== tools (XML) ===============

// All pure XML-normalization helpers (STRIP_WRAPPERS_RE, DSML_MARKER_STRIP_RE,
// SELF_CLOSING_TOOL_RE, normalizeAlternativeToolSyntax, stripUnclaimedToolTags,
// resolveInvokeToolName, resolveInvokeParamName) live in `common/xmlToolNormalize.ts`
// so they can be unit-tested in isolation. The only logic that stays here is
// the streaming-state machine (`extractXMLToolsWrapper`) — it owns transient
// per-stream buffers and can't be made pure.
//
// Tool/param name alias maps live in `common/prompt/toolAliases.ts` (TOOL_NAME_ALIASES,
// PARAM_ALIASES_BY_TOOL) — applied by both this file's parser and the dispatcher
// (chatThreadService._runToolCall) and AI SDK repair hook (aiSdkAdapter.ts) so
// every channel (native FC, legacy native, XML fallback) gets identical alias
// recovery.

/**
 * Partial-tag regexes — match in-progress vendor syntaxes at the buffer end so
 * the streaming state machine holds them in `openToolTagBuffer` instead of
 * flushing as user-visible text. Each must be anchored with `$` (end of buffer).
 *
 * Derived from `VENDOR_NAMESPACED_SUFFIXES` and `VENDOR_WRAPPER_NAMES` const
 * arrays (v0.13.11 audit pass X.15.7) — adding a new wrapper to either array
 * updates partial detection in lockstep. Pre-derivation, the literal patterns
 * `/<invoke\b[^>]*$/i` etc lived hardcoded here and silently lost coverage when
 * a new wrapper joined the strip list.
 */
const ALT_PARTIAL_REGEXES: RegExp[] = (() => {
	const wrapperAlt = VENDOR_WRAPPER_NAMES.join('|');
	const suffixAlt = VENDOR_NAMESPACED_SUFFIXES.join('|');
	return [
		// Namespaced opening / closing partial: `<vendor:tool_call`, `</vendor:invoke`, etc.
		new RegExp(`<\\/?[a-z][\\w-]*:(?:${suffixAlt})?[\\w_-]*$`, 'i'),
		// Bare wrapper partial: `<tool_calls`, `<function_calls`, etc. (open or close)
		new RegExp(`<\\/?(?:${wrapperAlt})\\b[^>]*$`, 'i'),
		// Invoke partial: `<invoke ...` (open) or `</invoke...` (close) without `>`.
		/<invoke\b[^>]*$/i,
		/<\/invoke\b[^>]*$/i,
		// Self-closing partial (v0.13.10): `<read_file path="d:\Project` etc.
		SELF_CLOSING_PARTIAL_RE,
		// X.6 — DSML fullwidth-pipe partial: `<｜｜DSML｜｜inv` mid-stream
		// without closing pipes. Without this, the marker leaks 50-300ms
		// onto screen between chunks before its closing `｜｜` arrives.
		// `\p{L}` matches Unicode-letter identifiers (X.15.6).
		/<[｜|]{1,4}[\p{L}][\p{L}\p{N}_-]*$/u,
		/<[｜|]{1,4}[\p{L}][\p{L}\p{N}_-]*[｜|]{0,4}[\p{L}\p{N}_-]*$/u,
	];
})();

const findPartiallyWrittenToolTagAtEnd = (fullText: string, toolTags: string[]) => {
	for (const toolTag of toolTags) {
		const foundPrefix = endsWithAnyPrefixOf(fullText, toolTag);
		if (foundPrefix) {
			return [foundPrefix, toolTag] as const;
		}
	}
	for (const re of ALT_PARTIAL_REGEXES) {
		const m = fullText.match(re);
		if (m && m.index !== undefined && m.index + m[0].length === fullText.length) {
			return [m[0], '<alt-syntax>'] as const;
		}
	}
	return false;
};

const findIndexOfAny = (fullText: string, matches: string[]) => {
	for (const str of matches) {
		const idx = fullText.indexOf(str);
		if (idx !== -1) {
			return [idx, str] as const;
		}
	}
	// Case-insensitive fallback. Models occasionally capitalize a tag
	// (<Read_File>, <BASH>); accept those too and report the literal substring
	// that was matched so downstream slicing remains correct.
	const lowerText = fullText.toLowerCase();
	for (const str of matches) {
		const idx = lowerText.indexOf(str.toLowerCase());
		if (idx !== -1) {
			const literalSlice = fullText.substring(idx, idx + str.length);
			return [idx, literalSlice] as const;
		}
	}
	return null;
};


type ToolOfToolName = { [toolName: string]: InternalToolInfo | undefined };

/**
 * Resolve an open-tag name (which may be an alias from another AI ecosystem)
 * to a canonical VibeIDE tool. Returns null if neither the original nor any
 * alias maps to a known tool.
 */
const resolveCanonicalToolName = (rawName: string, toolOfToolName: ToolOfToolName): string | null => {
	if (toolOfToolName[rawName]) { return rawName; }
	const aliasTarget = TOOL_NAME_ALIASES[rawName];
	if (aliasTarget && toolOfToolName[aliasTarget]) { return aliasTarget; }
	// Case-insensitive fallback. Canonical names are lowercase snake_case, but
	// models sometimes emit <Read_File> or <BASH>. Compare against a lowered
	// version of the registered names.
	const lowered = rawName.toLowerCase();
	if (lowered !== rawName) {
		if (toolOfToolName[lowered]) { return lowered; }
		const loweredAliasTarget = TOOL_NAME_ALIASES[lowered];
		if (loweredAliasTarget && toolOfToolName[loweredAliasTarget]) { return loweredAliasTarget; }
	}
	return null;
};

const parseXMLPrefixToToolCall = <T extends ToolName,>(rawToolName: T, toolId: string, str: string, toolOfToolName: ToolOfToolName): RawToolCallObj => {
	// Resolve alias → canonical (e.g. <bash> → run_command). The raw name was used
	// to find the open tag in the stream; from here on we operate against the
	// canonical tool's allowed params. Closing tag still matches the raw name.
	const canonicalToolName = (resolveCanonicalToolName(rawToolName, toolOfToolName) ?? rawToolName) as T;
	const paramAliasMap = PARAM_ALIASES_BY_TOOL[canonicalToolName] ?? {};

	const paramsObj: RawToolParamsObj = {};
	const doneParams: ToolParamName<T>[] = [];
	let isDone = false;

	const getAnswer = (): RawToolCallObj => {
		// trim off all whitespace at and before first \n and after last \n for each param
		for (const p in paramsObj) {
			const paramName = p as ToolParamName<T>;
			const orig = paramsObj[paramName];
			if (orig === undefined) { continue; }
			paramsObj[paramName] = trimBeforeAndAfterNewLines(orig);
		}

		// return tool call
		const ans: RawToolCallObj = {
			name: canonicalToolName,
			rawParams: paramsObj,
			doneParams: doneParams,
			isDone: isDone,
			id: toolId,
		};
		return ans;
	};

	// find first open tag (use the raw name the model actually emitted)
	const openToolTag = `<${rawToolName}>`;
	const i = str.indexOf(openToolTag);
	if (i === -1) { return getAnswer(); }
	let j = str.lastIndexOf(`</${rawToolName}>`);
	if (j === -1) { j = Infinity; }
	else { isDone = true; }


	str = str.substring(i + openToolTag.length, j);

	const pm = new SurroundingsRemover(str);

	const canonicalParams = Object.keys(toolOfToolName[canonicalToolName]?.params ?? {}) as ToolParamName<T>[];
	if (canonicalParams.length === 0) { return getAnswer(); }
	// Build the full set of param-tag spellings we'll try in priority order:
	// first the canonical names (tightest match), then any aliases (only if no
	// canonical name conflicts). Map each spelling back to its canonical name.
	const paramSpellingToCanonical: { [spelling: string]: ToolParamName<T> } = {};
	for (const p of canonicalParams) { paramSpellingToCanonical[p] = p; }
	for (const [aliasSpelling, canonicalTarget] of Object.entries(paramAliasMap)) {
		if (paramSpellingToCanonical[aliasSpelling]) { continue; } // never override a real param name
		if (canonicalParams.includes(canonicalTarget as ToolParamName<T>)) {
			paramSpellingToCanonical[aliasSpelling] = canonicalTarget as ToolParamName<T>;
		}
	}
	const allParamSpellings = Object.keys(paramSpellingToCanonical);
	let latestMatchedOpenParam: null | ToolParamName<T> = null;
	let latestMatchedSpelling: string | null = null;
	let n = 0;
	while (true) {
		n += 1;
		if (n > 20) { return getAnswer(); } // bumped to 20 — alias map can need more attempts on noisy streams

		// find the param name opening tag (canonical or alias)
		let matchedOpenParam: null | ToolParamName<T> = null;
		let matchedSpelling: string | null = null;
		for (const spelling of allParamSpellings) {
			const removed = pm.removeFromStartUntilFullMatch(`<${spelling}>`, true);
			if (removed) {
				matchedOpenParam = paramSpellingToCanonical[spelling];
				matchedSpelling = spelling;
				break;
			}
		}
		// if did not find a new param, stop
		if (matchedOpenParam === null) {
			if (latestMatchedOpenParam !== null) {
				paramsObj[latestMatchedOpenParam] += pm.value();
			}
			return getAnswer();
		}
		else {
			latestMatchedOpenParam = matchedOpenParam;
			latestMatchedSpelling = matchedSpelling;
		}

		if (paramsObj[latestMatchedOpenParam] === undefined) { paramsObj[latestMatchedOpenParam] = ''; }

		// find the matching close tag — try the spelling we opened with first,
		// then fall back to any other valid spelling for the same canonical param
		// (model may close with the canonical even if it opened with an alias).
		let matchedCloseParam: boolean = false;
		let paramContents = '';
		const closeSpellingsToTry = latestMatchedSpelling
			? [latestMatchedSpelling, ...allParamSpellings.filter(s => s !== latestMatchedSpelling && paramSpellingToCanonical[s] === latestMatchedOpenParam)]
			: allParamSpellings;
		for (const spelling of closeSpellingsToTry) {
			const i = pm.i;
			const closeTag = `</${spelling}>`;
			const removed = pm.removeFromStartUntilFullMatch(closeTag, true);
			if (removed) {
				const i2 = pm.i;
				paramContents = pm.originalS.substring(i, i2 - closeTag.length);
				matchedCloseParam = true;
				break;
			}
		}
		// if did not find a new close tag, stop
		if (!matchedCloseParam) {
			paramsObj[latestMatchedOpenParam] += pm.value();
			return getAnswer();
		}
		else {
			if (!doneParams.includes(latestMatchedOpenParam)) { doneParams.push(latestMatchedOpenParam); }
		}

		paramsObj[latestMatchedOpenParam] += paramContents;
	}
};

// `stripUnclaimedToolTags` moved to `../../common/xmlToolNormalize.ts` and is
// imported at the top of this file. Same regex pair as before (paired form
// `<tag>...</tag>` AND self-closing form `<tag attrs />`) — see the source
// module for the rationale and tests.

export const extractXMLToolsWrapper = (
	onText: OnText,
	onFinalMessage: OnFinalMessage,
	chatMode: ChatMode | null,
	mcpTools: InternalToolInfo[] | undefined,
): { newOnText: OnText; newOnFinalMessage: OnFinalMessage } => {

	if (!chatMode) { return { newOnText: onText, newOnFinalMessage: onFinalMessage }; }
	const tools = availableTools(chatMode, mcpTools);
	if (!tools) { return { newOnText: onText, newOnFinalMessage: onFinalMessage }; }

	const toolOfToolName: ToolOfToolName = {};
	for (const t of tools) { toolOfToolName[t.name] = t; }
	// Recognize both canonical names and known cross-ecosystem aliases
	// (e.g. <bash> from Anthropic-trained models → run_command).
	const canonicalTagSet = new Set(tools.map(t => t.name));
	const aliasTagsForActiveTools = Object.keys(TOOL_NAME_ALIASES).filter(alias => {
		const target = TOOL_NAME_ALIASES[alias];
		// only enable an alias if its canonical target is actually exposed in this chat mode
		// AND the alias isn't already a real tool name (avoid clobbering)
		return canonicalTagSet.has(target) && !canonicalTagSet.has(alias);
	});
	const toolOpenTags = [...tools.map(t => `<${t.name}>`), ...aliasTagsForActiveTools.map(a => `<${a}>`)];
	// `toolOpenTags` doubles as `partialDetectionTags` — the partial-tag detector
	// uses both endsWithAnyPrefixOf (matches per-tag prefix) AND ALT_PARTIAL_REGEXES
	// (shape-based vendor detection). Pre-X.16 had a separate `partialDetectionTags`
	// alias = `toolOpenTags`, useless indirection.

	const toolId = generateUuid();

	// detect <availableTools[0]></availableTools[0]>, etc
	let fullText = '';
	let trueFullText = '';
	let latestToolCall: RawToolCallObj | undefined = undefined;

	let foundOpenTag: { idx: number; toolName: ToolName } | null = null;
	let openToolTagBuffer = ''; // the characters we've seen so far that come after a < with no space afterwards, not yet added to fullText

	let prevNormalizedLen = 0;
	const newOnText: OnText = (params) => {
		// Normalize alternative tool-call syntaxes (<invoke name=...>, <tool_code>, etc.)
		// into our canonical <tool><param>...</param></tool> form. Until a closing
		// </invoke> arrives, the buffer is unchanged and the partial-tag hints below
		// hold the in-progress XML out of the user-visible chat.
		const normalizedFullText = normalizeAlternativeToolSyntax(params.fullText);
		// Length is non-monotonic: when </invoke> finally lands, the whole block
		// collapses to its shorter canonical form. Clamp so substring() stays valid.
		if (prevNormalizedLen > normalizedFullText.length) { prevNormalizedLen = normalizedFullText.length; }
		const newText = normalizedFullText.substring(prevNormalizedLen);
		prevNormalizedLen = normalizedFullText.length;
		trueFullText = normalizedFullText;

		if (foundOpenTag === null) {
			const newFullText = openToolTagBuffer + newText;
			// ensure the code below doesn't run if only half a tag has been written
			// (canonical or alt-syntax wrapper like <invoke ...> still streaming)
			const isPartial = findPartiallyWrittenToolTagAtEnd(newFullText, toolOpenTags);
			if (isPartial) {
				openToolTagBuffer += newText;
			}
			// if no tooltag is partially written at the end, attempt to get the index
			else {
				// we will instantly retroactively remove this if it's a tag match
				fullText += openToolTagBuffer;
				openToolTagBuffer = '';
				fullText += newText;

				// search the full normalized stream — alt-syntax blocks may be
				// earlier than the current incremental add (the block collapsed).
				const i = findIndexOfAny(trueFullText, toolOpenTags);
				if (i !== null) {
					const [idx, toolTag] = i;
					const toolName = toolTag.substring(1, toolTag.length - 1) as ToolName;
					foundOpenTag = { idx, toolName };

					// trim displayed text to just before the tool tag
					fullText = trueFullText.substring(0, idx);
				}
			}
		}

		// toolTagIdx is not null, so parse the XML
		if (foundOpenTag !== null) {
			latestToolCall = parseXMLPrefixToToolCall(
				foundOpenTag.toolName,
				toolId,
				trueFullText.substring(foundOpenTag.idx, Infinity),
				toolOfToolName,
			);
		}

		onText({
			...params,
			// Safety net: even if a tool tag slipped past the main parser (e.g. tool
			// not in current chatMode, or multi-tool emission past the first), don't
			// leak the raw `<read_file>...</read_file>` into user-visible chat. The
			// placeholder is non-disruptive markdown italic.
			fullText: stripUnclaimedToolTags(fullText),
			toolCall: latestToolCall,
		});
	};


	const newOnFinalMessage: OnFinalMessage = (params) => {
		// treat like just got text before calling onFinalMessage (or else we sometimes miss the final chunk that's new to finalMessage)
		newOnText({ ...params });

		fullText = fullText.trimEnd();
		const toolCall = latestToolCall;

		// console.log('final message!!!', trueFullText)
		// console.log('----- returning ----\n', fullText)
		// console.log('----- tools ----\n', JSON.stringify(firstToolCallRef.current, null, 2))
		// console.log('----- toolCall ----\n', JSON.stringify(toolCall, null, 2))

		onFinalMessage({ ...params, fullText: stripUnclaimedToolTags(fullText), toolCall: toolCall });
	};
	return { newOnText, newOnFinalMessage };
};



// trim all whitespace up until the first newline, and all whitespace up until the last newline
const trimBeforeAndAfterNewLines = (s: string) => {
	if (!s) { return s; }

	const firstNewLineIndex = s.indexOf('\n');

	if (firstNewLineIndex !== -1 && s.substring(0, firstNewLineIndex).trim() === '') {
		s = s.substring(firstNewLineIndex + 1, Infinity);
	}

	const lastNewLineIndex = s.lastIndexOf('\n');
	if (lastNewLineIndex !== -1 && s.substring(lastNewLineIndex + 1, Infinity).trim() === '') {
		s = s.substring(0, lastNewLineIndex);
	}

	return s;
};
