/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Smoke tests for model routing system
 *
 * These tests verify that the routing system correctly selects models for different task types.
 * Run these tests manually or integrate into your test suite.
 */

import { vibeLog } from './vibeLog.js';
import { TaskContext, ITaskAwareModelRouter } from './modelRouter.js';
import { ModelSelection } from './vibeideSettingsTypes.js';

export interface SmokeTestResult {
	name: string;
	passed: boolean;
	selectedModel?: ModelSelection;
	reasoning?: string;
	confidence?: number;
	error?: string;
}

/**
 * Run smoke tests for model routing
 */
export async function runRoutingSmokeTests(router: ITaskAwareModelRouter): Promise<SmokeTestResult[]> {
	const results: SmokeTestResult[] = [];

	// Test 1: Inline code edit
	results.push(await testInlineEdit(router));

	// Test 2: Multi-file refactor
	results.push(await testMultiFileRefactor(router));

	// Test 3: Code Q&A
	results.push(await testCodeQA(router));

	// Test 4: General Q&A
	results.push(await testGeneralQA(router));

	// Test 5: Image screenshot
	results.push(await testImageScreenshot(router));

	// Test 6: PDF pages 3-5
	results.push(await testPDFPages(router));

	// Test 7: Offline mode
	results.push(await testOfflineMode(router));

	// Test 8: Speculative escalation (low confidence)
	results.push(await testSpeculativeEscalation(router));

	return results;
}

async function testInlineEdit(router: ITaskAwareModelRouter): Promise<SmokeTestResult> {
	const context: TaskContext = {
		taskType: 'code',
		hasCode: true,
		isSimpleQuestion: false,
	};

	try {
		const decision = await router.route(context);
		const isCodeModel = decision.modelSelection.modelName.toLowerCase().includes('code') ||
			decision.modelSelection.modelName.toLowerCase().includes('coder') ||
			decision.modelSelection.modelName.toLowerCase().includes('devstral') ||
			decision.modelSelection.modelName.toLowerCase().includes('codestral');

		return {
			name: 'Inline code edit',
			passed: decision.confidence >= 0.5 && (isCodeModel || decision.confidence >= 0.7),
			selectedModel: decision.modelSelection,
			reasoning: decision.reasoning,
			confidence: decision.confidence,
		};
	} catch (error) {
		return {
			name: 'Inline code edit',
			passed: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function testMultiFileRefactor(router: ITaskAwareModelRouter): Promise<SmokeTestResult> {
	const context: TaskContext = {
		taskType: 'code',
		hasCode: true,
		isCodeReviewTask: true,
		requiresComplexReasoning: true,
		contextSize: 50000,
	};

	try {
		const decision = await router.route(context);
		const hasLargeContext = decision.modelSelection.modelName.toLowerCase().includes('4') ||
			decision.modelSelection.modelName.toLowerCase().includes('opus') ||
			decision.modelSelection.modelName.toLowerCase().includes('sonnet');

		return {
			name: 'Multi-file refactor',
			passed: decision.confidence >= 0.6 && (hasLargeContext || decision.confidence >= 0.8),
			selectedModel: decision.modelSelection,
			reasoning: decision.reasoning,
			confidence: decision.confidence,
		};
	} catch (error) {
		return {
			name: 'Multi-file refactor',
			passed: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function testCodeQA(router: ITaskAwareModelRouter): Promise<SmokeTestResult> {
	const context: TaskContext = {
		taskType: 'code',
		hasCode: false,
		requiresComplexReasoning: true,
		contextSize: 20000,
	};

	try {
		const decision = await router.route(context);
		return {
			name: 'Code Q&A',
			passed: decision.confidence >= 0.5,
			selectedModel: decision.modelSelection,
			reasoning: decision.reasoning,
			confidence: decision.confidence,
		};
	} catch (error) {
		return {
			name: 'Code Q&A',
			passed: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function testGeneralQA(router: ITaskAwareModelRouter): Promise<SmokeTestResult> {
	const context: TaskContext = {
		taskType: 'chat',
		isSimpleQuestion: true,
	};

	try {
		const decision = await router.route(context);
		return {
			name: 'General Q&A',
			passed: decision.confidence >= 0.4,
			selectedModel: decision.modelSelection,
			reasoning: decision.reasoning,
			confidence: decision.confidence,
		};
	} catch (error) {
		return {
			name: 'General Q&A',
			passed: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function testImageScreenshot(router: ITaskAwareModelRouter): Promise<SmokeTestResult> {
	const context: TaskContext = {
		taskType: 'vision',
		hasImages: true,
	};

	try {
		const decision = await router.route(context);
		const modelName = decision.modelSelection.modelName.toLowerCase();
		const provider = decision.modelSelection.providerName.toLowerCase();
		const isVisionModel = provider === 'gemini' ||
			modelName.includes('gpt-5') ||
			modelName.includes('4.1') ||
			modelName.includes('4o') ||
			modelName.startsWith('o1') ||
			modelName.startsWith('o3') ||
			modelName.startsWith('o4') ||
			modelName.includes('claude') ||
			modelName.includes('pixtral') ||
			modelName.includes('llava');

		return {
			name: 'Image screenshot',
			passed: decision.confidence >= 0.5 && isVisionModel,
			selectedModel: decision.modelSelection,
			reasoning: decision.reasoning,
			confidence: decision.confidence,
		};
	} catch (error) {
		return {
			name: 'Image screenshot',
			passed: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function testPDFPages(router: ITaskAwareModelRouter): Promise<SmokeTestResult> {
	const context: TaskContext = {
		taskType: 'pdf',
		hasPDFs: true,
		contextSize: 10000, // Pages 3-5 estimate
	};

	try {
		const decision = await router.route(context);
		const isVisionModel = decision.modelSelection.providerName.toLowerCase() === 'gemini' ||
			decision.modelSelection.modelName.toLowerCase().includes('4o') ||
			decision.modelSelection.modelName.toLowerCase().includes('4.1') ||
			decision.modelSelection.modelName.toLowerCase().includes('claude');

		return {
			name: 'PDF pages 3-5',
			passed: decision.confidence >= 0.5 && isVisionModel,
			selectedModel: decision.modelSelection,
			reasoning: decision.reasoning,
			confidence: decision.confidence,
		};
	} catch (error) {
		return {
			name: 'PDF pages 3-5',
			passed: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function testOfflineMode(router: ITaskAwareModelRouter): Promise<SmokeTestResult> {
	const context: TaskContext = {
		taskType: 'code',
		requiresPrivacy: true,
	};

	try {
		const decision = await router.route(context);
		const isLocal = decision.modelSelection.providerName.toLowerCase() === 'ollama' ||
			decision.modelSelection.providerName.toLowerCase() === 'vllm' ||
			decision.modelSelection.providerName.toLowerCase() === 'lmstudio';

		return {
			name: 'Offline mode',
			passed: isLocal,
			selectedModel: decision.modelSelection,
			reasoning: decision.reasoning,
			confidence: decision.confidence,
		};
	} catch (error) {
		return {
			name: 'Offline mode',
			passed: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function testSpeculativeEscalation(router: ITaskAwareModelRouter): Promise<SmokeTestResult> {
	// Create a context that should trigger low confidence (ambiguous task)
	const context: TaskContext = {
		taskType: 'chat',
		requiresComplexReasoning: true,
		isMultiStepTask: true,
		// No clear indicators - should have lower confidence
	};

	try {
		const decision = await router.route(context);
		// For speculative escalation, we expect either:
		// 1. Low confidence (< 0.6) OR
		// 2. Quality tier of 'escalate' OR
		// 3. A fast/cheap model selected with better model in fallback chain
		const hasFastModel = decision.modelSelection.modelName.toLowerCase().includes('mini') ||
			decision.modelSelection.modelName.toLowerCase().includes('haiku') ||
			decision.modelSelection.modelName.toLowerCase().includes('flash');
		const hasEscalationTarget = (decision.fallbackChain && decision.fallbackChain.length > 0) ?? false;

		const passed = decision.qualityTier === 'escalate' ||
			(decision.confidence < 0.6 && hasEscalationTarget) ||
			(hasFastModel && hasEscalationTarget);

		return {
			name: 'Speculative escalation',
			passed,
			selectedModel: decision.modelSelection,
			reasoning: decision.reasoning,
			confidence: decision.confidence,
		};
	} catch (error) {
		return {
			name: 'Speculative escalation',
			passed: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Print smoke test results
 */
export function printSmokeTestResults(results: SmokeTestResult[]): void {
	vibeLog.info('routingSmokeTests', '\n=== Model Routing Smoke Test Results ===\n');

	let passed = 0;
	let failed = 0;

	for (const result of results) {
		const status = result.passed ? '✓ PASS' : '✗ FAIL';
		vibeLog.info('routingSmokeTests', `${status} - ${result.name}`);

		if (result.selectedModel) {
			vibeLog.info('routingSmokeTests', `  Model: ${result.selectedModel.providerName}/${result.selectedModel.modelName}`);
		}
		if (result.confidence !== undefined) {
			vibeLog.info('routingSmokeTests', `  Confidence: ${(result.confidence * 100).toFixed(1)}%`);
		}
		if (result.reasoning) {
			vibeLog.info('routingSmokeTests', `  Reasoning: ${result.reasoning}`);
		}
		if (result.error) {
			vibeLog.info('routingSmokeTests', `  Error: ${result.error}`);
		}
		vibeLog.info('routingSmokeTests');

		if (result.passed) { passed++; }
		else { failed++; }
	}

	vibeLog.info('routingSmokeTests', `\nSummary: ${passed} passed, ${failed} failed out of ${results.length} tests\n`);
}

