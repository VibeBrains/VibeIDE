/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { resolveVideoTuning } from '../../common/video/vibeVideoConfiguration.js';
import { HDR_TO_SDR_FILTER, buildFramePassFilter, isHdrStreamLine, parseFfmpegFilterNames, sheetGrid, timecodeFontCandidates } from '../../common/video/videoFrameFilters.js';

suite('videoFrameFilters', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('HDR: PQ и HLG — да, SDR, 10 бит без HDR и обложка — нет', () => {
		assert.deepStrictEqual([
			isHdrStreamLine('Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/smpte2084), 3840x2160, 60 fps'),
			isHdrStreamLine('Stream #0:0: Video: hevc (Main), yuv420p(tv, bt2020nc/bt2020/arib-std-b67), 1920x1080, 30 fps'),
			isHdrStreamLine('Stream #0:0: Video: h264 (High), yuv420p(tv, bt709, progressive), 1280x720, 30 fps'),
			isHdrStreamLine('Stream #0:0: Video: hevc (Main 10), yuv420p10le(tv, bt709), 1920x1080, 30 fps'),
			isHdrStreamLine('Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 600x600 (attached pic)'),
		], [true, true, false, false, false]);
	});

	test('без tonemap и шрифта фильтр совпадает с прежним байт в байт', () => {
		assert.strictEqual(
			buildFramePassFilter({ threshold: 0.3, height: 720, tonemap: false }),
			`select='eq(n,0)+gt(scene,0.3)',scale=-2:'min(720,ih)',showinfo`,
		);
	});

	test('tonemap стоит между select и scale', () => {
		const filter = buildFramePassFilter({ threshold: 0.45, height: 480, tonemap: true });
		assert.deepStrictEqual([
			filter.startsWith(`select='eq(n,0)+gt(scene,0.45)',${HDR_TO_SDR_FILTER},scale=-2:'min(480,ih)',showinfo`),
			filter.indexOf(HDR_TO_SDR_FILTER) < filter.indexOf(`,scale=-2:'min(480,ih)'`),
		], [true, true]);
	});

	test('drawtext со шрифтом — между scale и showinfo, служебные знаки пути экранированы', () => {
		const filter = buildFramePassFilter({ threshold: 0.3, height: 720, tonemap: false, timecodeFont: 'C:\\Windows\\Fonts\\arial.ttf' });
		assert.deepStrictEqual([
			filter.startsWith(`select='eq(n,0)+gt(scene,0.3)',scale=-2:'min(720,ih)',drawtext=`),
			filter.includes('fontfile=C\\:/Windows/Fonts/arial.ttf'),
			filter.includes("text='%{pts\\:hms}'"),
			filter.includes('box=1:boxcolor=black@0.6'),
			filter.endsWith(',showinfo'),
			filter.indexOf('drawtext=') < filter.indexOf('showinfo'),
		], [true, true, true, true, true, true]);
	});

	test('сетки листов: до 12 кадров, не шире 4 колонок, последний лист — под остаток', () => {
		assert.deepStrictEqual([1, 4, 5, 12, 13, 25].map(count => sheetGrid(count)), [
			[{ cols: 1, rows: 1 }],
			[{ cols: 2, rows: 2 }],
			[{ cols: 3, rows: 2 }],
			[{ cols: 4, rows: 3 }],
			[{ cols: 4, rows: 3 }, { cols: 1, rows: 1 }],
			[{ cols: 4, rows: 3 }, { cols: 4, rows: 3 }, { cols: 1, rows: 1 }],
		]);
	});

	test('шрифты: пути платформы в порядке предпочтения', () => {
		assert.deepStrictEqual([
			timecodeFontCandidates('darwin')[0],
			timecodeFontCandidates('win32'),
			timecodeFontCandidates('linux').length,
		], ['/System/Library/Fonts/Helvetica.ttc', ['C:\\Windows\\Fonts\\arial.ttf', 'C:\\Windows\\Fonts\\segoeui.ttf'], 2]);
	});

	test('пресет efficient даёт листы, явная настройка перекрывает пресет', () => {
		assert.deepStrictEqual([
			resolveVideoTuning('efficient').frameLayout,
			resolveVideoTuning('balanced').frameLayout,
			resolveVideoTuning('efficient', { frameLayout: 'frames' }).frameLayout,
			resolveVideoTuning('balanced', { frameLayout: 'sheet' }).frameLayout,
			resolveVideoTuning('efficient', { frameLayout: 'мусор' }).frameLayout,
		], ['sheet', 'frames', 'frames', 'sheet', 'frames']);
	});

	test('parseFfmpegFilterNames: три знака свойств у ffmpeg 6 и два у ffmpeg 8, легенда не в счёт', () => {
		// Строки сняты с настоящего вывода `ffmpeg -filters`: 6.0 из video-tools и 8.1 из Homebrew
		const ffmpeg6 = [
			'Filters:',
			'  T.. = Timeline support',
			'  | = Source or sink filter',
			' ... abench            A->A       Benchmark part of a filtergraph.',
			' ... tile              V->V       Tile several successive frames together.',
			' .SC zscale            V->V       Apply resizing, colorspace and bit depth conversion.',
		].join('\n');
		const ffmpeg8 = [
			'Filters:',
			'  T.. = Timeline support',
			'  ------',
			' TS aap               AA->A      Apply Affine Projection algorithm to first audio stream.',
			' .. abench            A->A       Benchmark part of a filtergraph.',
			' .. tile              V->V       Tile several successive frames together.',
		].join('\n');
		assert.deepStrictEqual([[...parseFfmpegFilterNames(ffmpeg6)], [...parseFfmpegFilterNames(ffmpeg8)]], [
			['abench', 'tile', 'zscale'],
			['aap', 'abench', 'tile'],
		]);
	});
});
