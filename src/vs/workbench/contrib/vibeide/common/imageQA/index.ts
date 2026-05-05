/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Image QA Pipeline - Local-first image analysis
 *
 * This module provides:
 * - OCR → Structured JSON → Code LLM reasoning
 * - VLM for layout/region proposals
 * - Tiling & Zoom for high-DPI images
 * - Abstention & Recovery UX
 */

export { imageQARegistry, initializeModelRegistry, type ModelRole, type ImageType, type QuestionType, type ModelCapability } from './modelRegistry.js';
export { imageQARouter, type RoutingDecision } from './imageRouter.js';
export { getOCRService, type OCRResult, type OCRBlock, type IOCRService } from './ocrService.js';
export { imageQAPipeline, type QAResponse, type ImageQAOptions } from './imageQAPipeline.js';
export { evaluationFixtures, validateFixtureResponse, type EvaluationFixture, type SmokeTestResult } from './evaluationFixtures.js';
export { checkRemoteModelCall, logImageProcessingDecision, type SecurityCheckResult } from './securityGuardrails.js';

