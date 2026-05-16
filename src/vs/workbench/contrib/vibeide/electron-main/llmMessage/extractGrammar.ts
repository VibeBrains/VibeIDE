/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../../base/common/uuid.js'
import { endsWithAnyPrefixOf, SurroundingsRemover } from '../../common/helpers/extractCodeFromResult.js'
import { availableTools, InternalToolInfo } from '../../common/prompt/prompts.js'
import { TOOL_NAME_ALIASES, PARAM_ALIASES_BY_TOOL } from '../../common/prompt/toolAliases.js'
import { OnFinalMessage, OnText, RawToolCallObj, RawToolParamsObj } from '../../common/sendLLMMessageTypes.js'
import { ToolName, ToolParamName } from '../../common/toolsServiceTypes.js'
import { ChatMode } from '../../common/vibeideSettingsTypes.js'


// =============== reasoning ===============

// could simplify this - this assumes we can never add a tag without committing it to the user's screen, but that's not true
export const extractReasoningWrapper = (
	onText: OnText, onFinalMessage: OnFinalMessage, thinkTags: [string, string]
): { newOnText: OnText, newOnFinalMessage: OnFinalMessage } => {
	let latestAddIdx = 0 // exclusive index in fullText_
	let foundTag1 = false
	let foundTag2 = false

	let fullTextSoFar = ''
	let fullReasoningSoFar = ''


	if (!thinkTags[0] || !thinkTags[1]) throw new Error(`thinkTags must not be empty if provided. Got ${JSON.stringify(thinkTags)}.`)

	let onText_ = onText
	onText = (params) => {
		onText_(params)
	}

	const newOnText: OnText = ({ fullText: fullText_, ...p }) => {

		// until found the first think tag, keep adding to fullText
		if (!foundTag1) {
			const endsWithTag1 = endsWithAnyPrefixOf(fullText_, thinkTags[0])
			if (endsWithTag1) {
				// console.log('endswith1', { fullTextSoFar, fullReasoningSoFar, fullText_ })
				// wait until we get the full tag or know more
				return
			}
			// if found the first tag
			const tag1Index = fullText_.indexOf(thinkTags[0])
			if (tag1Index !== -1) {
				// console.log('tag1Index !==1', { tag1Index, fullTextSoFar, fullReasoningSoFar, thinkTags, fullText_ })
				foundTag1 = true
				// Add text before the tag to fullTextSoFar
				fullTextSoFar += fullText_.substring(0, tag1Index)
				// Update latestAddIdx to after the first tag
				latestAddIdx = tag1Index + thinkTags[0].length
				onText({ ...p, fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar })
				return
			}

			// console.log('adding to text A', { fullTextSoFar, fullReasoningSoFar })
			// add the text to fullText
			fullTextSoFar = fullText_
			latestAddIdx = fullText_.length
			onText({ ...p, fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar })
			return
		}

		// at this point, we found <tag1>

		// until found the second think tag, keep adding to fullReasoning
		if (!foundTag2) {
			const endsWithTag2 = endsWithAnyPrefixOf(fullText_, thinkTags[1])
			if (endsWithTag2 && endsWithTag2 !== thinkTags[1]) { // if ends with any partial part (full is fine)
				// console.log('endsWith2', { fullTextSoFar, fullReasoningSoFar })
				// wait until we get the full tag or know more
				return
			}

			// if found the second tag
			const tag2Index = fullText_.indexOf(thinkTags[1], latestAddIdx)
			if (tag2Index !== -1) {
				// console.log('tag2Index !== -1', { fullTextSoFar, fullReasoningSoFar })
				foundTag2 = true
				// Add everything between first and second tag to reasoning
				fullReasoningSoFar += fullText_.substring(latestAddIdx, tag2Index)
				// Update latestAddIdx to after the second tag
				latestAddIdx = tag2Index + thinkTags[1].length
				onText({ ...p, fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar })
				return
			}

			// add the text to fullReasoning (content after first tag but before second tag)
			// console.log('adding to text B', { fullTextSoFar, fullReasoningSoFar })

			// If we have more text than we've processed, add it to reasoning
			if (fullText_.length > latestAddIdx) {
				fullReasoningSoFar += fullText_.substring(latestAddIdx)
				latestAddIdx = fullText_.length
			}

			onText({ ...p, fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar })
			return
		}

		// at this point, we found <tag2> - content after the second tag is normal text
		// console.log('adding to text C', { fullTextSoFar, fullReasoningSoFar })

		// Add any new text after the closing tag to fullTextSoFar
		if (fullText_.length > latestAddIdx) {
			fullTextSoFar += fullText_.substring(latestAddIdx)
			latestAddIdx = fullText_.length
		}

		onText({ ...p, fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar })
	}


	const getOnFinalMessageParams = () => {
		const fullText_ = fullTextSoFar
		const tag1Idx = fullText_.indexOf(thinkTags[0])
		const tag2Idx = fullText_.indexOf(thinkTags[1])
		if (tag1Idx === -1) return { fullText: fullText_, fullReasoning: '' } // never started reasoning
		if (tag2Idx === -1) return { fullText: '', fullReasoning: fullText_ } // never stopped reasoning

		const fullReasoning = fullText_.substring(tag1Idx + thinkTags[0].length, tag2Idx)
		const fullText = fullText_.substring(0, tag1Idx) + fullText_.substring(tag2Idx + thinkTags[1].length, Infinity)

		return { fullText, fullReasoning }
	}

	const newOnFinalMessage: OnFinalMessage = (params) => {

		// treat like just got text before calling onFinalMessage (or else we sometimes miss the final chunk that's new to finalMessage)
		newOnText({ ...params })

		const { fullText, fullReasoning } = getOnFinalMessageParams()
		onFinalMessage({ ...params, fullText, fullReasoning })
	}

	return { newOnText, newOnFinalMessage }
}


// =============== tools (XML) ===============

// Tool name + per-tool param-name aliases moved to common/prompt/toolAliases.ts
// so the dispatcher (chatThreadService._runToolCall) and the AI SDK repair
// hook (aiSdkAdapter.ts) can apply the same map. Previously these were
// XML-only, which left AI SDK native function-calling and legacy native
// channels with no recovery for cross-ecosystem name/field differences
// (e.g. minimax/qwen emitting `{path: ...}` for read_file → undefined uri).
// See: TOOL_NAME_ALIASES and PARAM_ALIASES_BY_TOOL imports above.

/**
 * Outer wrapper tags used by some models to frame a list of tool invocations.
 * Detected by SHAPE rather than by enumerated vendor list:
 *   - Fixed canonicals: <tool_code> (Gemini), <function_calls> (Anthropic),
 *     <tool_use>, <tools>.
 *   - Vendor-namespaced: any <vendor:suffix> where the suffix carries a
 *     "tool" or "function" semantic — covers <minimax:tool_call>,
 *     <claude:tool_use>, <mistral:function_call>, <openai:invoke>, plus
 *     any future vendor that follows the same convention.
 *
 * The actual tool call lives inside as <invoke name=...>. Wrappers are
 * stripped first; whatever remains is fed to the invoke-pattern normalizer.
 */
const STRIP_WRAPPERS_RE = /<\/?(?:tool_code|function_calls|tool_use|tools|[a-z][\w-]*:(?:tool_call|tool_use|function_call|function_calls|invoke|tools))\s*>/gi

/**
 * Resolve a tool name as it appears inside <invoke name="X"> to a canonical
 * VibeIDE tool. Case-insensitive (models occasionally capitalize: "Bash",
 * "Read_File"); the alias map is keyed in lowercase.
 */
const resolveInvokeToolName = (rawName: string): string => {
	const lower = rawName.toLowerCase()
	if (TOOL_NAME_ALIASES[lower]) return TOOL_NAME_ALIASES[lower]
	// Already-canonical name (case-insensitive). Return the lowercase form so
	// downstream comparisons against the canonical-tag set succeed.
	return lower
}

/**
 * Same idea for param names inside <arg name="Y"> / <parameter name="Y">.
 * The param alias map is keyed in lowercase per tool; canonical params are
 * snake_case lowercase too, so lowercasing once is safe.
 */
const resolveInvokeParamName = (rawParamName: string, canonicalToolName: string): string => {
	const lower = rawParamName.toLowerCase()
	const paramAliasMap = PARAM_ALIASES_BY_TOOL[canonicalToolName] ?? {}
	return paramAliasMap[lower] ?? lower
}

/**
 * Convert Anthropic-style <invoke name="X"><arg name="Y">V</arg></invoke>
 * (and <parameter name=...> variant) into our canonical <X><Y>V</Y></X>
 * format BEFORE the regular parser sees it. Tool/param names go through the
 * same alias resolution as the canonical-tag path (and case-insensitively),
 * so the model can mix syntaxes freely:
 *   <invoke name="Bash"> → <run_command>
 *   <minimax:tool_call><invoke name="bash"> ... </invoke></minimax:tool_call> → <run_command>...
 *
 * Conversion only fires once the full invoke block (including </invoke>) is
 * present in the buffer. Until then the partial-tag detector holds the
 * characters in `openToolTagBuffer` so they don't leak into the chat as text.
 */
const normalizeAlternativeToolSyntax = (text: string): string => {
	// Fast path: no alternative-syntax markers present at all.
	// Cheap substring sniffs first — if any plausibly-namespaced or invoke
	// pattern is present, fall through to the regex pipeline.
	if (!text.includes('<invoke') && !text.includes('<tool_code') && !text.includes('<function_calls') && !text.includes('<tool_use') && !text.includes(':tool_call') && !text.includes(':tool_use') && !text.includes(':function_call') && !text.includes(':invoke')) {
		return text
	}
	let result = text.replace(STRIP_WRAPPERS_RE, '')
	result = result.replace(
		/<invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/invoke>/gi,
		(_match: string, rawToolName: string, body: string) => {
			const canonical = resolveInvokeToolName(rawToolName)
			const transformedBody = body.replace(
				/<(?:arg|parameter)\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/(?:arg|parameter)>/gi,
				(_m: string, rawParamName: string, value: string) => {
					const canonicalParam = resolveInvokeParamName(rawParamName, canonical)
					return `<${canonicalParam}>${value}</${canonicalParam}>`
				}
			)
			return `<${canonical}>${transformedBody}</${canonical}>`
		}
	)
	return result
}

/**
 * Regex patterns that identify in-progress alt-syntax tool calls at the end
 * of the buffer. Used as additional partial-tag hints so half-written wrapper
 * or invoke openings are held in `openToolTagBuffer` instead of leaking into
 * chat. Each pattern must be anchored with `$` so it only matches at end.
 *
 * Detection by SHAPE — no enumerated vendor list:
 *   - `<vendor:partial`  → any `<word_chars:partial_chars` ending with no `>`
 *   - `<invoke …` → any `<invoke` followed by anything not yet containing `>`
 *   - `</vendor:partial` → closing form of the above
 */
const ALT_PARTIAL_REGEXES: RegExp[] = [
	/<\/?[a-z][\w-]*:[\w_-]*$/i,
	/<invoke\b[^>]*$/i,
	/<\/invoke\b[^>]*$/i,
]

const findPartiallyWrittenToolTagAtEnd = (fullText: string, toolTags: string[]) => {
	for (const toolTag of toolTags) {
		const foundPrefix = endsWithAnyPrefixOf(fullText, toolTag)
		if (foundPrefix) {
			return [foundPrefix, toolTag] as const
		}
	}
	for (const re of ALT_PARTIAL_REGEXES) {
		const m = fullText.match(re)
		if (m && m.index !== undefined && m.index + m[0].length === fullText.length) {
			return [m[0], '<alt-syntax>'] as const
		}
	}
	return false
}

const findIndexOfAny = (fullText: string, matches: string[]) => {
	for (const str of matches) {
		const idx = fullText.indexOf(str);
		if (idx !== -1) {
			return [idx, str] as const
		}
	}
	// Case-insensitive fallback. Models occasionally capitalize a tag
	// (<Read_File>, <BASH>); accept those too and report the literal substring
	// that was matched so downstream slicing remains correct.
	const lowerText = fullText.toLowerCase()
	for (const str of matches) {
		const idx = lowerText.indexOf(str.toLowerCase())
		if (idx !== -1) {
			const literalSlice = fullText.substring(idx, idx + str.length)
			return [idx, literalSlice] as const
		}
	}
	return null
}


type ToolOfToolName = { [toolName: string]: InternalToolInfo | undefined }

/**
 * Resolve an open-tag name (which may be an alias from another AI ecosystem)
 * to a canonical VibeIDE tool. Returns null if neither the original nor any
 * alias maps to a known tool.
 */
const resolveCanonicalToolName = (rawName: string, toolOfToolName: ToolOfToolName): string | null => {
	if (toolOfToolName[rawName]) return rawName
	const aliasTarget = TOOL_NAME_ALIASES[rawName]
	if (aliasTarget && toolOfToolName[aliasTarget]) return aliasTarget
	// Case-insensitive fallback. Canonical names are lowercase snake_case, but
	// models sometimes emit <Read_File> or <BASH>. Compare against a lowered
	// version of the registered names.
	const lowered = rawName.toLowerCase()
	if (lowered !== rawName) {
		if (toolOfToolName[lowered]) return lowered
		const loweredAliasTarget = TOOL_NAME_ALIASES[lowered]
		if (loweredAliasTarget && toolOfToolName[loweredAliasTarget]) return loweredAliasTarget
	}
	return null
}

const parseXMLPrefixToToolCall = <T extends ToolName,>(rawToolName: T, toolId: string, str: string, toolOfToolName: ToolOfToolName): RawToolCallObj => {
	// Resolve alias → canonical (e.g. <bash> → run_command). The raw name was used
	// to find the open tag in the stream; from here on we operate against the
	// canonical tool's allowed params. Closing tag still matches the raw name.
	const canonicalToolName = (resolveCanonicalToolName(rawToolName, toolOfToolName) ?? rawToolName) as T
	const paramAliasMap = PARAM_ALIASES_BY_TOOL[canonicalToolName] ?? {}

	const paramsObj: RawToolParamsObj = {}
	const doneParams: ToolParamName<T>[] = []
	let isDone = false

	const getAnswer = (): RawToolCallObj => {
		// trim off all whitespace at and before first \n and after last \n for each param
		for (const p in paramsObj) {
			const paramName = p as ToolParamName<T>
			const orig = paramsObj[paramName]
			if (orig === undefined) continue
			paramsObj[paramName] = trimBeforeAndAfterNewLines(orig)
		}

		// return tool call
		const ans: RawToolCallObj = {
			name: canonicalToolName,
			rawParams: paramsObj,
			doneParams: doneParams,
			isDone: isDone,
			id: toolId,
		}
		return ans
	}

	// find first open tag (use the raw name the model actually emitted)
	const openToolTag = `<${rawToolName}>`
	let i = str.indexOf(openToolTag)
	if (i === -1) return getAnswer()
	let j = str.lastIndexOf(`</${rawToolName}>`)
	if (j === -1) j = Infinity
	else isDone = true


	str = str.substring(i + openToolTag.length, j)

	const pm = new SurroundingsRemover(str)

	const canonicalParams = Object.keys(toolOfToolName[canonicalToolName]?.params ?? {}) as ToolParamName<T>[]
	if (canonicalParams.length === 0) return getAnswer()
	// Build the full set of param-tag spellings we'll try in priority order:
	// first the canonical names (tightest match), then any aliases (only if no
	// canonical name conflicts). Map each spelling back to its canonical name.
	const paramSpellingToCanonical: { [spelling: string]: ToolParamName<T> } = {}
	for (const p of canonicalParams) paramSpellingToCanonical[p] = p
	for (const [aliasSpelling, canonicalTarget] of Object.entries(paramAliasMap)) {
		if (paramSpellingToCanonical[aliasSpelling]) continue // never override a real param name
		if (canonicalParams.includes(canonicalTarget as ToolParamName<T>)) {
			paramSpellingToCanonical[aliasSpelling] = canonicalTarget as ToolParamName<T>
		}
	}
	const allParamSpellings = Object.keys(paramSpellingToCanonical)
	let latestMatchedOpenParam: null | ToolParamName<T> = null
	let latestMatchedSpelling: string | null = null
	let n = 0
	while (true) {
		n += 1
		if (n > 20) return getAnswer() // bumped to 20 — alias map can need more attempts on noisy streams

		// find the param name opening tag (canonical or alias)
		let matchedOpenParam: null | ToolParamName<T> = null
		let matchedSpelling: string | null = null
		for (const spelling of allParamSpellings) {
			const removed = pm.removeFromStartUntilFullMatch(`<${spelling}>`, true)
			if (removed) {
				matchedOpenParam = paramSpellingToCanonical[spelling]
				matchedSpelling = spelling
				break
			}
		}
		// if did not find a new param, stop
		if (matchedOpenParam === null) {
			if (latestMatchedOpenParam !== null) {
				paramsObj[latestMatchedOpenParam] += pm.value()
			}
			return getAnswer()
		}
		else {
			latestMatchedOpenParam = matchedOpenParam
			latestMatchedSpelling = matchedSpelling
		}

		if (paramsObj[latestMatchedOpenParam] === undefined) paramsObj[latestMatchedOpenParam] = ''

		// find the matching close tag — try the spelling we opened with first,
		// then fall back to any other valid spelling for the same canonical param
		// (model may close with the canonical even if it opened with an alias).
		let matchedCloseParam: boolean = false
		let paramContents = ''
		const closeSpellingsToTry = latestMatchedSpelling
			? [latestMatchedSpelling, ...allParamSpellings.filter(s => s !== latestMatchedSpelling && paramSpellingToCanonical[s] === latestMatchedOpenParam)]
			: allParamSpellings
		for (const spelling of closeSpellingsToTry) {
			const i = pm.i
			const closeTag = `</${spelling}>`
			const removed = pm.removeFromStartUntilFullMatch(closeTag, true)
			if (removed) {
				const i2 = pm.i
				paramContents = pm.originalS.substring(i, i2 - closeTag.length)
				matchedCloseParam = true
				break
			}
		}
		// if did not find a new close tag, stop
		if (!matchedCloseParam) {
			paramsObj[latestMatchedOpenParam] += pm.value()
			return getAnswer()
		}
		else {
			if (!doneParams.includes(latestMatchedOpenParam)) doneParams.push(latestMatchedOpenParam)
		}

		paramsObj[latestMatchedOpenParam] += paramContents
	}
}

export const extractXMLToolsWrapper = (
	onText: OnText,
	onFinalMessage: OnFinalMessage,
	chatMode: ChatMode | null,
	mcpTools: InternalToolInfo[] | undefined,
): { newOnText: OnText, newOnFinalMessage: OnFinalMessage } => {

	if (!chatMode) return { newOnText: onText, newOnFinalMessage: onFinalMessage }
	const tools = availableTools(chatMode, mcpTools)
	if (!tools) return { newOnText: onText, newOnFinalMessage: onFinalMessage }

	const toolOfToolName: ToolOfToolName = {}
	for (const t of tools) { toolOfToolName[t.name] = t }
	// Recognize both canonical names and known cross-ecosystem aliases
	// (e.g. <bash> from Anthropic-trained models → run_command).
	const canonicalTagSet = new Set(tools.map(t => t.name))
	const aliasTagsForActiveTools = Object.keys(TOOL_NAME_ALIASES).filter(alias => {
		const target = TOOL_NAME_ALIASES[alias]
		// only enable an alias if its canonical target is actually exposed in this chat mode
		// AND the alias isn't already a real tool name (avoid clobbering)
		return canonicalTagSet.has(target) && !canonicalTagSet.has(alias)
	})
	const toolOpenTags = [...tools.map(t => `<${t.name}>`), ...aliasTagsForActiveTools.map(a => `<${a}>`)]
	// Alt-syntax partial detection (vendor wrappers, <invoke name=...>, etc.)
	// is now handled by ALT_PARTIAL_REGEXES inside findPartiallyWrittenToolTagAtEnd
	// — shape-based, no enumerated vendor list.
	const partialDetectionTags = toolOpenTags

	const toolId = generateUuid()

	// detect <availableTools[0]></availableTools[0]>, etc
	let fullText = '';
	let trueFullText = ''
	let latestToolCall: RawToolCallObj | undefined = undefined

	let foundOpenTag: { idx: number, toolName: ToolName } | null = null
	let openToolTagBuffer = '' // the characters we've seen so far that come after a < with no space afterwards, not yet added to fullText

	let prevNormalizedLen = 0
	const newOnText: OnText = (params) => {
		// Normalize alternative tool-call syntaxes (<invoke name=...>, <tool_code>, etc.)
		// into our canonical <tool><param>...</param></tool> form. Until a closing
		// </invoke> arrives, the buffer is unchanged and the partial-tag hints below
		// hold the in-progress XML out of the user-visible chat.
		const normalizedFullText = normalizeAlternativeToolSyntax(params.fullText)
		// Length is non-monotonic: when </invoke> finally lands, the whole block
		// collapses to its shorter canonical form. Clamp so substring() stays valid.
		if (prevNormalizedLen > normalizedFullText.length) prevNormalizedLen = normalizedFullText.length
		const newText = normalizedFullText.substring(prevNormalizedLen)
		prevNormalizedLen = normalizedFullText.length
		trueFullText = normalizedFullText

		if (foundOpenTag === null) {
			const newFullText = openToolTagBuffer + newText
			// ensure the code below doesn't run if only half a tag has been written
			// (canonical or alt-syntax wrapper like <invoke ...> still streaming)
			const isPartial = findPartiallyWrittenToolTagAtEnd(newFullText, partialDetectionTags)
			if (isPartial) {
				openToolTagBuffer += newText
			}
			// if no tooltag is partially written at the end, attempt to get the index
			else {
				// we will instantly retroactively remove this if it's a tag match
				fullText += openToolTagBuffer
				openToolTagBuffer = ''
				fullText += newText

				// search the full normalized stream — alt-syntax blocks may be
				// earlier than the current incremental add (the block collapsed).
				const i = findIndexOfAny(trueFullText, toolOpenTags)
				if (i !== null) {
					const [idx, toolTag] = i
					const toolName = toolTag.substring(1, toolTag.length - 1) as ToolName
					foundOpenTag = { idx, toolName }

					// trim displayed text to just before the tool tag
					fullText = trueFullText.substring(0, idx)
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
			)
		}

		onText({
			...params,
			fullText,
			toolCall: latestToolCall,
		});
	};


	const newOnFinalMessage: OnFinalMessage = (params) => {
		// treat like just got text before calling onFinalMessage (or else we sometimes miss the final chunk that's new to finalMessage)
		newOnText({ ...params })

		fullText = fullText.trimEnd()
		const toolCall = latestToolCall

		// console.log('final message!!!', trueFullText)
		// console.log('----- returning ----\n', fullText)
		// console.log('----- tools ----\n', JSON.stringify(firstToolCallRef.current, null, 2))
		// console.log('----- toolCall ----\n', JSON.stringify(toolCall, null, 2))

		onFinalMessage({ ...params, fullText, toolCall: toolCall })
	}
	return { newOnText, newOnFinalMessage };
}



// trim all whitespace up until the first newline, and all whitespace up until the last newline
const trimBeforeAndAfterNewLines = (s: string) => {
	if (!s) return s;

	const firstNewLineIndex = s.indexOf('\n');

	if (firstNewLineIndex !== -1 && s.substring(0, firstNewLineIndex).trim() === '') {
		s = s.substring(firstNewLineIndex + 1, Infinity)
	}

	const lastNewLineIndex = s.lastIndexOf('\n');
	if (lastNewLineIndex !== -1 && s.substring(lastNewLineIndex + 1, Infinity).trim() === '') {
		s = s.substring(0, lastNewLineIndex)
	}

	return s
}
