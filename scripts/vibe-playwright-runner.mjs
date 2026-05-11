#!/usr/bin/env node
/**
 * VibeIDE Browser Automation Runner
 *
 * Spawned as a child process by VibeBrowserAutomationService._executeRun().
 * Reads an AutomationScript from stdin (JSON), executes it via Playwright,
 * and writes a BrowserRunResult to stdout (JSON) on exit.
 *
 * Protocol:
 *   stdin:  { script: AutomationScript, startUrl?: string, maxMs?: number }
 *   stdout: { status, consoleOutput, screenshotPath?, message?, elapsedMs }
 *   exit 0 on completed/rejected, exit 1 on internal error
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONSOLE_MAX_BYTES = 8 * 1024;

async function run() {
	let input = '';
	for await (const chunk of process.stdin) { input += chunk; }

	let parsed;
	try { parsed = JSON.parse(input); }
	catch { reply({ status: 'failed', message: 'invalid JSON input' }); return; }

	const { script, startUrl, maxMs = 30_000 } = parsed;
	const start = Date.now();
	const consoleLines = [];
	let screenshotPath;
	let browser;

	const timer = setTimeout(() => {
		reply({ status: 'timed_out', message: `Exceeded maxMs=${maxMs}`, consoleOutput: consoleLines.join('\n').slice(0, CONSOLE_MAX_BYTES), elapsedMs: Date.now() - start });
		process.exit(0);
	}, maxMs);

	try {
		browser = await chromium.launch({ headless: true });
		const page = await browser.newPage();

		page.on('console', msg => {
			const line = `[${msg.type()}] ${msg.text()}`;
			if (consoleLines.join('\n').length < CONSOLE_MAX_BYTES) { consoleLines.push(line); }
		});

		if (startUrl) { await page.goto(startUrl, { timeout: 15_000 }); }

		for (const step of (script?.steps ?? [])) {
			const timeout = Math.min(step.timeoutMs ?? 30_000, 600_000);
			switch (step.kind) {
				case 'navigate':
					await page.goto(step.value, { timeout });
					break;
				case 'click':
					await page.click(step.target, { timeout });
					break;
				case 'fill':
					await page.fill(step.target, step.value ?? '', { timeout });
					break;
				case 'select-option':
					await page.selectOption(step.target, step.value ?? '', { timeout });
					break;
				case 'press-key':
					await page.keyboard.press(step.value ?? '', { delay: 50 });
					break;
				case 'wait-for-selector':
					await page.waitForSelector(step.target, { timeout });
					break;
				case 'wait-for-network-idle':
					await page.waitForLoadState('networkidle', { timeout });
					break;
				case 'screenshot': {
					const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-browser-'));
					screenshotPath = path.join(tmpDir, `${step.id}.png`);
					await page.screenshot({ path: screenshotPath, fullPage: false });
					break;
				}
				case 'extract-text': {
					const text = await page.textContent(step.target, { timeout });
					consoleLines.push(`[extract-text:${step.id}] ${(text ?? '').slice(0, 500)}`);
					break;
				}
			}
		}

		clearTimeout(timer);
		reply({
			status: 'completed',
			consoleOutput: consoleLines.join('\n').slice(0, CONSOLE_MAX_BYTES),
			screenshotPath,
			elapsedMs: Date.now() - start,
		});
	} catch (err) {
		clearTimeout(timer);
		reply({
			status: 'failed',
			message: String(err),
			consoleOutput: consoleLines.join('\n').slice(0, CONSOLE_MAX_BYTES),
			elapsedMs: Date.now() - start,
		});
	} finally {
		await browser?.close().catch(() => undefined);
	}
}

function reply(result) {
	process.stdout.write(JSON.stringify(result) + '\n');
}

run().catch(err => {
	reply({ status: 'failed', message: String(err), elapsedMs: 0 });
	process.exit(1);
});
