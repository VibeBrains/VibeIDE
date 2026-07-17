/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { isRemoteVideoInput, resolveVideoToolPaths, videoToolsArchiveForPlatform } from '../../../common/video/vibeVideoTools.js';
import { formatVideoTimecode, selectEvenlySpreadFrames } from '../../../common/video/vibeVideoTypes.js';
import { clampVideoMaxFrames, clampVideoSceneThreshold, normalizeVideoSubtitleLanguages } from '../../../common/video/vibeVideoConfiguration.js';

suite('vibeVideoTools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('platform mapping covers supported combos and rejects the rest', () => {
		assert.deepStrictEqual(
			[
				videoToolsArchiveForPlatform('darwin', 'arm64')?.platform,
				videoToolsArchiveForPlatform('darwin', 'x64')?.platform,
				videoToolsArchiveForPlatform('win32', 'x64')?.platform,
				videoToolsArchiveForPlatform('linux', 'x64')?.platform,
				videoToolsArchiveForPlatform('linux', 'arm64'),
				videoToolsArchiveForPlatform('win32', 'arm64'),
			],
			['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64', undefined, undefined],
		);
	});

	test('catalog entries are internally consistent', () => {
		for (const [platform, arch] of [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64'], ['linux', 'x64']] as const) {
			const archive = videoToolsArchiveForPlatform(platform, arch)!;
			assert.ok(/^[0-9a-f]{64}$/.test(archive.sha256), `${archive.platform}: sha256 format`);
			assert.ok(archive.sizeBytes > 1024 * 1024, `${archive.platform}: plausible size`);
			assert.ok(archive.url.endsWith(`video-tools-${archive.platform}.zip`), `${archive.platform}: url matches platform`);
			const exe = platform === 'win32' ? '.exe' : '';
			assert.deepStrictEqual([...archive.files], [`ffmpeg${exe}`, `yt-dlp${exe}`]);
		}
	});

	test('resolveVideoToolPaths joins root, version dir and file names', () => {
		const archive = videoToolsArchiveForPlatform('darwin', 'arm64')!;
		const paths = resolveVideoToolPaths('/data/video-tools', archive);
		assert.deepStrictEqual(paths, {
			ffmpeg: '/data/video-tools/v1/ffmpeg',
			ytDlp: '/data/video-tools/v1/yt-dlp',
		});
	});

	test('isRemoteVideoInput', () => {
		assert.deepStrictEqual(
			[
				isRemoteVideoInput('https://youtu.be/x'),
				isRemoteVideoInput(' HTTP://example.com/a.mp4 '),
				isRemoteVideoInput('/Users/me/видео.mp4'),
				isRemoteVideoInput('C:\\video\\clip.mp4'),
			],
			[true, true, false, false],
		);
	});

	test('formatVideoTimecode', () => {
		assert.deepStrictEqual(
			[formatVideoTimecode(0), formatVideoTimecode(13.2), formatVideoTimecode(75), formatVideoTimecode(3671), formatVideoTimecode(-5)],
			['00:00', '00:13', '01:15', '1:01:11', '00:00'],
		);
	});

	test('selectEvenlySpreadFrames keeps first frame and even spread', () => {
		const frames = Array.from({ length: 10 }, (_, i) => i);
		assert.deepStrictEqual(selectEvenlySpreadFrames(frames, 4), [0, 3, 6, 9]);
		assert.deepStrictEqual(selectEvenlySpreadFrames(frames, 20), frames);
		assert.deepStrictEqual(selectEvenlySpreadFrames(frames, 1), [0]);
		assert.deepStrictEqual(selectEvenlySpreadFrames(frames, 0), []);
	});

	test('configuration clamps', () => {
		assert.deepStrictEqual(
			[clampVideoSceneThreshold(0.3), clampVideoSceneThreshold(5), clampVideoSceneThreshold('x'), clampVideoMaxFrames(1000), clampVideoMaxFrames(undefined)],
			[0.3, 0.9, 0.3, 150, 48],
		);
	});

	test('normalizeVideoSubtitleLanguages filters junk and keeps order', () => {
		assert.deepStrictEqual(
			[
				normalizeVideoSubtitleLanguages('ru,en'),
				normalizeVideoSubtitleLanguages(' EN , ru-RU ,, bad lang!'),
				normalizeVideoSubtitleLanguages(''),
				normalizeVideoSubtitleLanguages(42),
			],
			['ru,en', 'en,ru-ru', 'ru,en', 'ru,en'],
		);
	});
});
