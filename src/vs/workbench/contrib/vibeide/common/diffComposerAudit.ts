/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Diff/Composer Performance Audit
 *
 * Measures panel open time, hunk rendering time, apply/undo latency
 */

export interface DiffComposerMetrics {
	// Panel operations
	panelOpenTime: number; // Time to open composer panel (ms)
	panelRenderTime: number; // Time to render initial content (ms)

	// Hunk operations
	hunkCount: number;
	hunkRenderTime: number; // Time to render all hunks (ms)
	hunkRenderTimePerHunk: number; // Average time per hunk (ms)
	largeDiffTime: number; // Time for diffs with 100+ hunks (ms)

	// Apply/Undo operations
	applyTime: number; // Time to apply changes (ms)
	undoTime: number; // Time to undo changes (ms)
	applyFileCount: number; // Number of files in apply operation

	// Error tracking
	applyErrors: number;
	undoErrors: number;

	timestamp: number;
	requestId: string;
}

class DiffComposerAudit {
	private contexts: Map<string, {
		panelOpenStart?: number;
		panelRenderStart?: number;
		hunkRenderStart?: number;
		hunkCount: number;
		applyStart?: number;
		undoStart?: number;
		errors: { apply: number; undo: number };
	}> = new Map();

	/**
	 * Start tracking a composer session
	 */
	startSession(requestId: string): void {
		this.contexts.set(requestId, {
			hunkCount: 0,
			errors: { apply: 0, undo: 0 },
		});
	}

	/**
	 * Mark panel open start
	 */
	markPanelOpenStart(requestId: string): void {
		const context = this.contexts.get(requestId);
		if (context) {
			context.panelOpenStart = performance.now();
		}
	}

	/**
	 * Mark panel open complete
	 */
	markPanelOpenEnd(requestId: string): void {
		const context = this.contexts.get(requestId);
		if (context && context.panelOpenStart) {
			context.panelRenderStart = performance.now();
		}
	}

	/**
	 * Mark hunk rendering start
	 */
	markHunkRenderStart(requestId: string): void {
		const context = this.contexts.get(requestId);
		if (context) {
			context.hunkRenderStart = performance.now();
		}
	}

	/**
	 * Mark hunk count
	 */
	markHunkCount(requestId: string, count: number): void {
		const context = this.contexts.get(requestId);
		if (context) {
			context.hunkCount = count;
		}
	}

	/**
	 * Mark hunk rendering complete
	 */
	markHunkRenderEnd(requestId: string): void {
		// Hunk rendering is complete when all hunks are rendered
		// This is called after the last hunk is rendered
	}

	/**
	 * Mark apply start
	 */
	markApplyStart(requestId: string): void {
		const context = this.contexts.get(requestId);
		if (context) {
			context.applyStart = performance.now();
		}
	}

	/**
	 * Mark apply complete
	 */
	markApplyEnd(requestId: string, success: boolean): void {
		const context = this.contexts.get(requestId);
		if (context) {
			if (!success) {
				context.errors.apply++;
			}
		}
	}

	/**
	 * Mark undo start
	 */
	markUndoStart(requestId: string): void {
		const context = this.contexts.get(requestId);
		if (context) {
			context.undoStart = performance.now();
		}
	}

	/**
	 * Mark undo complete
	 */
	markUndoEnd(requestId: string, success: boolean): void {
		const context = this.contexts.get(requestId);
		if (context) {
			if (!success) {
				context.errors.undo++;
			}
		}
	}

	/**
	 * Get metrics for a session
	 */
	getMetrics(requestId: string, fileCount: number = 0): DiffComposerMetrics | null {
		const context = this.contexts.get(requestId);
		if (!context) return null;

		const now = performance.now();
		const panelOpenTime = context.panelOpenStart && context.panelRenderStart
			? context.panelRenderStart - context.panelOpenStart
			: 0;
		const panelRenderTime = context.panelRenderStart && context.hunkRenderStart
			? context.hunkRenderStart - context.panelRenderStart
			: 0;
		const hunkRenderTime = context.hunkRenderStart
			? (now - context.hunkRenderStart)
			: 0;

		const applyTime = context.applyStart
			? (now - context.applyStart)
			: 0;
		const undoTime = context.undoStart
			? (now - context.undoStart)
			: 0;

		return {
			panelOpenTime,
			panelRenderTime,
			hunkCount: context.hunkCount,
			hunkRenderTime,
			hunkRenderTimePerHunk: context.hunkCount > 0 ? hunkRenderTime / context.hunkCount : 0,
			largeDiffTime: context.hunkCount >= 100 ? hunkRenderTime : 0,
			applyTime,
			undoTime,
			applyFileCount: fileCount,
			applyErrors: context.errors.apply,
			undoErrors: context.errors.undo,
			timestamp: Date.now(),
			requestId,
		};
	}

	/**
	 * Complete and remove a session
	 */
	completeSession(requestId: string, fileCount: number = 0): DiffComposerMetrics | null {
		const metrics = this.getMetrics(requestId, fileCount);
		this.contexts.delete(requestId);
		return metrics;
	}
}

// Singleton instance
export const diffComposerAudit = new DiffComposerAudit();

