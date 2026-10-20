/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { join } from '../../../../../../base/common/path.js';
import { classifyWatchInput, isRemoteVideoInput, resolveVideoToolPaths, resolveWatchTarget, videoToolsArchiveForPlatform, WatchTargetEnvironment } from '../../../common/video/vibeVideoTools.js';
import { formatVideoTimecode, selectEvenlySpreadFrames } from '../../../common/video/vibeVideoTypes.js';
import { clampVideoMaxFrames, clampVideoSceneThreshold, normalizeVideoSubtitleLanguages, resolveVideoTuning } from '../../../common/video/vibeVideoConfiguration.js';

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
		// `join` uses the host separator (backslash on Windows) — normalize before comparing so the
		// readable forward-slash expectation holds on every platform.
		assert.deepStrictEqual({
			ffmpeg: paths.ffmpeg.replace(/\\/g, '/'),
			ytDlp: paths.ytDlp.replace(/\\/g, '/'),
		}, {
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

	test('classifyWatchInput hints audio/video by extension, platform pages stay unknown', () => {
		assert.deepStrictEqual(
			[
				classifyWatchInput('/Users/me/Syna2.MP3'),
				classifyWatchInput('C:\\records\\голосовое.ogg'),
				classifyWatchInput('https://cdn.example.com/episode.m4a?token=abc#t=10'),
				classifyWatchInput(' /home/me/clip.webm '),
				classifyWatchInput('https://example.com/movie.MP4'),
				classifyWatchInput('https://youtu.be/5r_Mh-dCjJ8'),
				classifyWatchInput('https://podcasts.example.com/show/123'),
				classifyWatchInput('/home/me/.hidden'),
				classifyWatchInput('/home/me/archive.txt'),
			],
			['audio', 'audio', 'audio', 'video', 'video', 'unknown', 'unknown', 'unknown', 'unknown'],
		);
	});

	test('classifyWatchInput strips query/fragment for URLs only — # and ? are legal in file names', () => {
		assert.deepStrictEqual(
			[
				classifyWatchInput('/Users/me/Track #1.mp3'),
				classifyWatchInput('C:\\Music\\Track #1.mp3'),
				classifyWatchInput('/tmp/what?.wav'),
				classifyWatchInput('https://cdn.example.com/live.mp4#t=30'),
			],
			['audio', 'audio', 'audio', 'video'],
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

	suite('detail presets', () => {
		test('each level maps to its own tuning; unknown falls back to balanced', () => {
			assert.deepStrictEqual(
				[
					resolveVideoTuning('transcript'),
					resolveVideoTuning('efficient'),
					resolveVideoTuning('balanced'),
					resolveVideoTuning('token-burner'),
					resolveVideoTuning('nonsense'),
				],
				[
					{ framesEnabled: false, sceneThreshold: 0.3, maxFrames: 4, frameHeight: 480 },
					{ framesEnabled: true, sceneThreshold: 0.45, maxFrames: 16, frameHeight: 480 },
					{ framesEnabled: true, sceneThreshold: 0.3, maxFrames: 48, frameHeight: 720 },
					{ framesEnabled: true, sceneThreshold: 0.12, maxFrames: 150, frameHeight: 1080 },
					{ framesEnabled: true, sceneThreshold: 0.3, maxFrames: 48, frameHeight: 720 },
				],
			);
		});

		test('an explicitly set knob overrides the preset — and only that knob', () => {
			assert.deepStrictEqual(
				resolveVideoTuning('token-burner', { maxFrames: 10 }),
				{ framesEnabled: true, sceneThreshold: 0.12, maxFrames: 10, frameHeight: 1080 },
			);
		});

		test('explicit values are still clamped, undefined leaves the preset alone', () => {
			assert.deepStrictEqual(
				[
					resolveVideoTuning('efficient', { maxFrames: 9000, frameHeight: 1, sceneThreshold: 99 }),
					resolveVideoTuning('efficient', { maxFrames: undefined }),
				],
				[
					{ framesEnabled: true, sceneThreshold: 0.9, maxFrames: 150, frameHeight: 240 },
					{ framesEnabled: true, sceneThreshold: 0.45, maxFrames: 16, frameHeight: 480 },
				],
			);
		});
	});

	suite('watch target resolution', () => {

		const root = join('/work', 'test');
		const home = join('/home', 'user');

		function environment(files: readonly string[], workspaceFolders: readonly string[] = [root]): WatchTargetEnvironment {
			const existing = new Set(files);
			return { workspaceFolders, homeDir: home, isFile: async absolutePath => existing.has(absolutePath) };
		}

		test('relative paths resolve from the project folder: bare name, ./, nested, ../ — normalised, trimmed', async () => {
			const env = environment([join(root, '1.webm'), join(root, 'sub', 'dir', '2.webm'), join(root, '..', 'x.mp4')]);
			assert.deepStrictEqual(
				await Promise.all(['1.webm', ' ./1.webm ', 'sub/dir/2.webm', '../x.mp4'].map(input => resolveWatchTarget(input, env))),
				[
					{ kind: 'resolved', target: join(root, '1.webm') },
					{ kind: 'resolved', target: join(root, '1.webm') },
					{ kind: 'resolved', target: join(root, 'sub', 'dir', '2.webm') },
					{ kind: 'resolved', target: join(root, '..', 'x.mp4') },
				],
			);
		});

		test('several project folders: searched in order, the first one holding the file wins', async () => {
			const first = join('/work', 'a');
			const second = join('/work', 'b');
			const env = environment([join(first, 'both.mp4'), join(second, 'both.mp4'), join(second, 'only-b.mp4')], [first, second]);
			assert.deepStrictEqual(
				await Promise.all(['both.mp4', 'only-b.mp4', 'none.mp4'].map(input => resolveWatchTarget(input, env))),
				[
					{ kind: 'resolved', target: join(first, 'both.mp4') },
					{ kind: 'resolved', target: join(second, 'only-b.mp4') },
					{ kind: 'missing', scope: 'project', folders: [first, second] },
				],
			);
		});

		test('an absolute path is taken as it is; ~/ goes from the home folder and a bare name never does', async () => {
			const env = environment([join(home, 'Videos', 'c.mp4'), join(root, 'c.mp4'), '/abs/clip.webm']);
			assert.deepStrictEqual(
				await Promise.all(['/abs/clip.webm', '~/Videos/c.mp4', 'Videos/c.mp4'].map(input => resolveWatchTarget(input, env))),
				[
					{ kind: 'resolved', target: '/abs/clip.webm' },
					{ kind: 'resolved', target: join(home, 'Videos', 'c.mp4') },
					{ kind: 'missing', scope: 'project', folders: [root] },
				],
			);
		});

		test('a missing file says where it was searched: the absolute path, the home folder, the project folders', async () => {
			const withRoot = environment([]);
			assert.deepStrictEqual(
				[
					await resolveWatchTarget('/abs/none.webm', withRoot),
					await resolveWatchTarget('~/none.mp4', withRoot),
					await resolveWatchTarget('none.webm', environment([], [])),
					await resolveWatchTarget('none.webm', withRoot),
				],
				[
					{ kind: 'missing', scope: 'absolute' },
					{ kind: 'missing', scope: 'home' },
					{ kind: 'missing', scope: 'project', folders: [] },
					{ kind: 'missing', scope: 'project', folders: [root] },
				],
			);
		});

		test('a URL is passed as it is and never looked up on disk', async () => {
			let lookups = 0;
			const env: WatchTargetEnvironment = { workspaceFolders: [root], homeDir: home, isFile: async () => { lookups++; return false; } };
			assert.deepStrictEqual(
				[await resolveWatchTarget(' https://youtu.be/abc ', env), lookups],
				[{ kind: 'resolved', target: 'https://youtu.be/abc' }, 0],
			);
		});
	});
});
