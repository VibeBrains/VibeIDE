/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DocumentSnapshot, reviewDesign } from '../../common/designReview/designSlopRules.js';
import { RULE } from '../../common/designReview/ruleIds.js';
import { injectReloadScript } from '../../common/vibeServer/injectReloadScript.js';

/**
 * Дизайн-проверки на НАСТОЯЩЕЙ странице в настоящем браузере.
 *
 * Остальные тесты каталога кормят правила синтетическими снимками — они проверяют суждение, но не
 * то, откуда берутся числа. А числа собирает скрипт, внедряемый в страницу (`injectReloadScript`),
 * и до сих пор он проверялся только ручным смоуком: «сборщик отдаёт то, что правило ожидает» было
 * договорённостью двух файлов, а не фактом.
 *
 * Здесь фикстура открывается в iframe, в неё внедряется ТОТ ЖЕ скрипт, что и в превью, снимок
 * снимается ЕГО замером и отдаётся НАСТОЯЩИМ правилам. Поэтому тест ловит расхождение между
 * сборщиком и правилом — единственное, чего синтетический снимок поймать не может по устройству.
 */
suite('дизайн-проверки на настоящей странице', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const frames: HTMLIFrameElement[] = [];
	teardown(() => {
		for (const frame of frames.splice(0)) { frame.remove(); }
	});

	/** Страница целиком: фикстура пишет только то, что проверяет, остальное — нейтральный фон. */
	const page = (body: string, opts: { head?: string; bodyStyle?: string } = {}): string => `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Фикстура дизайн-проверки</title>
<meta name="description" content="Страница-фикстура для проверки сборщика снимка и правил детектора.">
${opts.head ?? ''}
<style>body{margin:0;background:#ffffff;color:#1a1a1a;font:16px/1.5 Helvetica,Arial,sans-serif;}</style>
</head><body style="${opts.bodyStyle ?? ''}">${body}</body></html>`;

	/**
	 * Снять снимок фикстуры тем же скриптом, что работает в превью.
	 *
	 * `srcdoc` намеренно: страница наследует источник теста, поэтому `parent.postMessage` из скрипта
	 * доходит сюда. Хоста у такой страницы нет — скрипт это переживает (проверяется заодно).
	 */
	const snapshotOf = (html: string, viewport: 'desktop' | 'mobile' = 'desktop', widthPx = 900): Promise<DocumentSnapshot> => {
		const frame = document.createElement('iframe');
		frames.push(frame);
		frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${widthPx}px;height:600px;border:0;`;
		frame.srcdoc = injectReloadScript(html);
		return new Promise<DocumentSnapshot>((resolve, reject) => {
			const timer = setTimeout(() => { cleanup(); reject(new Error('страница не ответила снимком за 5 с')); }, 5000);
			const onMessage = (event: MessageEvent) => {
				const data = event.data as { __vibeBrowser?: string; snapshot?: DocumentSnapshot; error?: string } | null;
				if (!data || data.__vibeBrowser !== 'design-scan') { return; }
				cleanup();
				if (data.error) { reject(new Error(data.error)); return; }
				resolve(data.snapshot!);
			};
			const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', onMessage); };
			window.addEventListener('message', onMessage);
			frame.addEventListener('load', () => {
				frame.contentWindow?.postMessage({ __vibeServerDesignScan: true, viewport }, '*');
			});
			document.body.appendChild(frame);
		});
	};

	const rulesOf = (findings: readonly { rule: string }[]): string[] => [...new Set(findings.map(f => f.rule))];

	test('сборщик доезжает: снимок непустой и описывает ту самую страницу', async () => {
		const snapshot = await snapshotOf(page('<main><h1>Заголовок</h1><p>Текст страницы.</p></main>'));
		assert.deepStrictEqual({
			естьЭлементы: snapshot.elements.length > 0,
			естьЗаголовок: snapshot.headings.some(h => h.text === 'Заголовок'),
			// Заголовок и описание читаются из настоящего `<head>`, а не сочиняются.
			title: snapshot.seo?.title,
			язык: snapshot.seo?.htmlLang,
			естьМетаВьюпорт: snapshot.seo?.hasViewportMeta,
		}, {
			естьЭлементы: true,
			естьЗаголовок: true,
			title: 'Фикстура дизайн-проверки',
			язык: 'ru',
			естьМетаВьюпорт: true,
		});
	});

	test('опрятная страница не даёт находок пола качества', async () => {
		const snapshot = await snapshotOf(page(`
			<main style="max-width:640px;margin:40px auto;padding:0 16px;">
				<h1 style="font-size:32px;margin:0 0 16px;">Отчёт за квартал</h1>
				<p style="margin:0 0 12px;">Выручка выросла, расходы под контролем.</p>
				<button style="font-size:16px;padding:10px 18px;background:#1b5e20;color:#ffffff;border:0;border-radius:6px;">Открыть отчёт</button>
			</main>`));
		const floor = reviewDesign(snapshot).filter(f => f.ruleClass === 'floor');
		// Ложная тревога на опрятной странице дороже пропущенной находки: она учит не верить детектору.
		assert.deepStrictEqual(rulesOf(floor), []);
	});

	test('содержимое шире контейнера — находка приходит из настоящего замера', async () => {
		const snapshot = await snapshotOf(page(`
			<div style="width:200px;overflow:hidden;border:1px solid #333;">
				<div style="width:600px;height:40px;background:#eeeeee;">очень широкий блок</div>
			</div>`));
		assert.ok(rulesOf(reviewDesign(snapshot)).includes(RULE.contentOverflow), rulesOf(reviewDesign(snapshot)).join(', '));
	});

	test('страница шире окна — документ меряется, а не предполагается', async () => {
		const snapshot = await snapshotOf(page('<div style="width:1600px;height:80px;background:#f0f0f0;">широкая полоса</div>'), 'desktop', 600);
		assert.ok(rulesOf(reviewDesign(snapshot)).includes(RULE.pageOverflow), rulesOf(reviewDesign(snapshot)).join(', '));
	});

	test('абсолютный ребёнок уехал за обрезающего родителя — тот самый прецедент корзины', async () => {
		const snapshot = await snapshotOf(page(`
			<div style="position:relative;width:120px;height:60px;overflow:hidden;background:#fafafa;">
				<div style="position:absolute;left:100px;top:10px;width:60px;height:24px;background:#c62828;">удалить</div>
			</div>`));
		assert.ok(rulesOf(reviewDesign(snapshot)).includes(RULE.clippedPositionedChild), rulesOf(reviewDesign(snapshot)).join(', '));
	});

	test('контраст считается по фону ПРЕДКА, а не по своему прозрачному', async () => {
		// Ровно то, чего синтетический снимок не проверяет: у абзаца фон прозрачный, и сборщик
		// обязан подняться по предкам до первого непрозрачного.
		const snapshot = await snapshotOf(page(`
			<section style="background:#ffffff;padding:20px;">
				<p style="color:#bdbdbd;margin:0;">Светло-серый текст на белом предке</p>
			</section>`));
		assert.ok(rulesOf(reviewDesign(snapshot)).includes(RULE.lowContrast), rulesOf(reviewDesign(snapshot)).join(', '));
	});

	test('картинка без alt и поле без подписи — разметка читается по-настоящему', async () => {
		const snapshot = await snapshotOf(page(`
			<main>
				<img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" width="40" height="40">
				<input type="text" placeholder="Ваше имя" style="font-size:16px;padding:8px;">
			</main>`));
		const rules = rulesOf(reviewDesign(snapshot));
		assert.deepStrictEqual({
			картинкаБезAlt: rules.includes(RULE.imageWithoutAlt),
			полеБезПодписи: rules.includes(RULE.fieldWithoutLabel),
		}, { картинкаБезAlt: true, полеБезПодписи: true }, rules.join(', '));
	});

	test('снятая обводка ловится, а обычная кнопка — нет', async () => {
		// Две половины одного факта. В покое вычисленный `outline-style` равен `none` У ОБЕИХ кнопок,
		// поэтому различать их можно только по объявлению в таблице стилей.
		const snapshot = await snapshotOf(page(
			'<main><button class="bare">Обычная</button> <button class="stripped">Без фокуса</button></main>',
			{ head: '<style>.stripped{outline:none;border:0;padding:10px 16px;background:#1b5e20;color:#fff;}</style>' }));
		const focus = reviewDesign(snapshot).filter(f => f.rule === RULE.focusNotVisible);
		assert.deepStrictEqual({
			сколько: focus.length,
			наКого: focus[0]?.selector.includes('stripped'),
		}, { сколько: 1, наКого: true }, JSON.stringify(focus.map(f => f.selector)));
	});

	test('пустой заголовок страницы виден только в снимке `<head>`', async () => {
		const html = page('<main><p>Текст.</p></main>').replace('<title>Фикстура дизайн-проверки</title>', '<title></title>');
		const snapshot = await snapshotOf(html);
		assert.ok(rulesOf(reviewDesign(snapshot)).includes(RULE.seoMissingTitle), rulesOf(reviewDesign(snapshot)).join(', '));
	});
});
