/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ToolDef } from './_helpers.js';

/**
 * The name and the fields are the family's: VibeIDEA ships `vibe_watch_media` with the same `source` and `question`, and the
 * shared rule `watch-media` (VibeBrains) tells the model how to call either one, so one rule serves both products.
 */
export const WATCH_MEDIA_TOOL: ToolDef<'watch_media'> = {
	name: 'watch_media',
	description: `Watches a video or listens to an audio recording and returns what is in it: the transcript with timecodes and the key frames. Works on a local file or a link (YouTube, Loom, a direct media URL, a podcast, a call recording, a voice message).

Call it whenever the user asks to watch a video, go through a clip, a recording or a call, listen to audio, or transcribe a recording. Do NOT answer that you cannot open video or look for a 'watch' skill: this tool is how it is done.

The transcript comes from the subtitles of the link, or from local speech recognition when there are none. Frames are cut at scene changes, not at equal intervals, so they are the moments where the picture changed. A tool answer carries no pictures, so the frames come as text: a timecode and a line about what is on screen, written by a vision model (the 'vibeide.video.frameModel' setting, else the chat model when it can see images). When nobody could look at the frames, the answer says so and lists their timecodes only. Never invent lines, scenes or numbers the answer does not have; say what is missing and rely on what came. Refer to timecodes ('at 4:12 a chart is shown'), not to 'the middle'.

The first run offers to download the helper tools (yt-dlp, ffmpeg) and asks the user to agree. A long recording takes minutes: the user sees the progress and can cancel it.`,
	params: {
		source: { description: `The file or the link exactly as the user wrote it: an absolute path, a path from the project root (clips/demo.mp4), or an http(s) link. A path taken from an @-attachment goes as it is.` },
		question: { description: `Optional. What the user wants to know about the recording; it also tells which frames to describe in more detail. Leave it out for a general retelling.` },
	},
};
