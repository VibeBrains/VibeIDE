/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Evaluation Fixtures for Image QA Pipeline
 * Small test set for smoke testing
 */

import { ImageType, QuestionType } from './modelRegistry.js';

export interface EvaluationFixture {
	name: string;
	description: string;
	imageType: ImageType;
	questionType: QuestionType;
	question: string;
	expectedMinChars?: number; // Minimum OCR chars expected
	expectedRouterPath?: 'ocr_code' | 'vlm_only' | 'ocr_vlm_hybrid';
	expectedBlocks?: number; // Minimum blocks expected
	expectedContains?: string[]; // Answers should contain these keywords
}

/**
 * Test fixtures for smoke testing
 * In production, these would load actual test images
 */
export const evaluationFixtures: EvaluationFixture[] = [
	{
		name: 'Terminal Error',
		description: 'Terminal screenshot with error message',
		imageType: 'terminal/log',
		questionType: 'explain_error',
		question: 'What is this error and how do I fix it?',
		expectedMinChars: 50,
		expectedRouterPath: 'ocr_code',
		expectedBlocks: 3,
		expectedContains: ['error', 'exception', 'stack'],
	},
	{
		name: 'Code Exception',
		description: 'Code editor showing exception/stack trace',
		imageType: 'code_screenshot',
		questionType: 'explain_error',
		question: 'What caused this exception?',
		expectedMinChars: 30,
		expectedRouterPath: 'ocr_code',
		expectedBlocks: 2,
		expectedContains: ['exception', 'at ', 'line'],
	},
	{
		name: 'Package.json Diff',
		description: 'Git diff showing package.json changes',
		imageType: 'code_screenshot',
		questionType: "what's_shown",
		question: 'What changed in package.json?',
		expectedMinChars: 40,
		expectedRouterPath: 'ocr_code',
		expectedBlocks: 5,
		expectedContains: ['package.json', 'dependencies'],
	},
	{
		name: 'CI Failure Log',
		description: 'CI/CD pipeline failure output',
		imageType: 'terminal/log',
		questionType: 'summarize_logs',
		question: 'Why did the CI fail?',
		expectedMinChars: 60,
		expectedRouterPath: 'ocr_code',
		expectedBlocks: 4,
		expectedContains: ['failed', 'test', 'error'],
	},
	{
		name: 'Chart Visualization',
		description: 'Chart or graph image',
		imageType: 'chart/diagram',
		questionType: "what's_shown",
		question: 'What does this chart show?',
		expectedRouterPath: 'vlm_only',
		// Charts may not have much OCR text
		expectedMinChars: 0,
	},
	{
		name: 'UI with Tiny Text',
		description: 'UI screenshot with small text that needs zoom',
		imageType: 'UI/app',
		questionType: 'find_UI_element',
		question: 'Where is the settings button?',
		expectedRouterPath: 'ocr_vlm_hybrid',
		expectedMinChars: 20,
		expectedContains: ['button', 'settings'],
	},
];

/**
 * Run smoke tests on a fixture
 * Returns pass/fail with details
 */
export interface SmokeTestResult {
	fixtureName: string;
	passed: boolean;
	checks: {
		ocrCharCount: { passed: boolean; actual?: number; expected?: number };
		routerPath: { passed: boolean; actual?: string; expected?: string };
		blockCount: { passed: boolean; actual?: number; expected?: number };
		citedBlocks: { passed: boolean; actual?: number[] };
		confidence: { passed: boolean; actual?: number; threshold: number };
	};
	errors: string[];
}

/**
 * Validate a QA response against fixture expectations
 */
export function validateFixtureResponse(
	fixture: EvaluationFixture,
	response: { answer: string; confidence: number; citedBlocks?: number[]; ocrChars?: number; routerPath?: string; blockCount?: number }
): SmokeTestResult {
	const checks = {
		ocrCharCount: {
			passed: fixture.expectedMinChars === undefined || (response.ocrChars ?? 0) >= fixture.expectedMinChars,
			actual: response.ocrChars,
			expected: fixture.expectedMinChars,
		},
		routerPath: {
			passed: fixture.expectedRouterPath === undefined || response.routerPath === fixture.expectedRouterPath,
			actual: response.routerPath,
			expected: fixture.expectedRouterPath,
		},
		blockCount: {
			passed: fixture.expectedBlocks === undefined || (response.blockCount ?? 0) >= fixture.expectedBlocks,
			actual: response.blockCount,
			expected: fixture.expectedBlocks,
		},
		citedBlocks: {
			passed: response.citedBlocks !== undefined && response.citedBlocks.length > 0,
			actual: response.citedBlocks,
		},
		confidence: {
			passed: response.confidence >= 0.5,
			actual: response.confidence,
			threshold: 0.5,
		},
	};

	const errors: string[] = [];
	if (!checks.ocrCharCount.passed) {
		errors.push(`OCR char count too low: ${checks.ocrCharCount.actual} < ${checks.ocrCharCount.expected}`);
	}
	if (!checks.routerPath.passed) {
		errors.push(`Router path mismatch: ${checks.routerPath.actual} !== ${checks.routerPath.expected}`);
	}
	if (!checks.blockCount.passed) {
		errors.push(`Block count too low: ${checks.blockCount.actual} < ${checks.blockCount.expected}`);
	}
	if (!checks.citedBlocks.passed) {
		errors.push('No blocks were cited in the answer');
	}
	if (!checks.confidence.passed) {
		errors.push(`Confidence too low: ${checks.confidence.actual} < ${checks.confidence.threshold}`);
	}

	// Check if answer contains expected keywords
	if (fixture.expectedContains) {
		const answerLower = response.answer.toLowerCase();
		const missingKeywords = fixture.expectedContains.filter(k => !answerLower.includes(k.toLowerCase()));
		if (missingKeywords.length > 0) {
			errors.push(`Answer missing keywords: ${missingKeywords.join(', ')}`);
		}
	}

	const passed = Object.values(checks).every(c => c.passed) && errors.length === 0;

	return {
		fixtureName: fixture.name,
		passed,
		checks,
		errors,
	};
}

