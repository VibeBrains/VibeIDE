/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../vibeLog.js';
import { TelemetryEvent, RoutingDecisionEvent, AnyTelemetryEvent, TelemetryQuery } from './telemetryTypes.js';

// Node builtins are loaded lazily via require() because this module lives in the
// layer-agnostic `common/**` folder, which forbids static node imports. The service
// is only functional in node/electron-main contexts (gated on `this.fs`).
const nodeUtil: typeof import('util') = require('util');
const nodeZlib: typeof import('zlib') = require('zlib');
const path: typeof import('path') = require('path');

const gzipAsync = nodeUtil.promisify(nodeZlib.gzip);
const gunzipAsync = nodeUtil.promisify(nodeZlib.gunzip);

/**
 * Storage service for telemetry data
 * Stores telemetry locally (privacy-first, never send to cloud unless user opts in)
 */
export class TelemetryStorageService {
	private readonly storageDir: string;
	private readonly maxStorageSize: number = 500 * 1024 * 1024; // 500MB
	private readonly retentionDays: number = 30;
	private readonly fs: typeof import('fs') | null;

	constructor() {
		// Use Node.js fs (only available in electron-main context)
		// For browser context, we'll need to use IndexedDB or similar
		// For now, this will only work in electron-main
		let fsModule: typeof import('fs') | null;
		try {
			fsModule = require('fs');
		} catch {
			// Browser context - will need alternative storage
			fsModule = null;
		}
		this.fs = fsModule;

		// Get storage directory from environment or use default
		const userDataPath = process.env.VSCODE_USER_DATA_PATH ||
			(process.platform === 'darwin'
				? path.join(process.env.HOME || '', 'Library', 'Application Support', 'VibeIDE')
				: process.platform === 'win32'
					? path.join(process.env.APPDATA || '', 'VibeIDE')
					: path.join(process.env.HOME || '', '.config', 'VibeIDE'));

		this.storageDir = path.join(userDataPath, 'telemetry');
		this._ensureStorageDir();
	}

	private _ensureStorageDir(): void {
		if (!this.fs) { return; } // Browser context - skip
		if (!this.fs.existsSync(this.storageDir)) {
			this.fs.mkdirSync(this.storageDir, { recursive: true });
		}
	}

	/**
	 * Write events to disk (compressed with gzip)
	 * Format: telemetry-YYYY-MM-DD.jsonl.gz
	 * One JSON object per line (JSONL)
	 */
	async writeEvents(events: TelemetryEvent[]): Promise<void> {
		if (events.length === 0) { return; }
		if (!this.fs) {
			// Browser context - would need IndexedDB implementation
			vibeLog.warn('telemetryStorage', '[TelemetryStorage] File system not available in browser context');
			return;
		}

		const today = new Date().toISOString().split('T')[0];
		const filename = `telemetry-${today}.jsonl.gz`;
		const filepath = path.join(this.storageDir, filename);

		// Read existing file if it exists
		let existingLines: string[] = [];
		if (this.fs.existsSync(filepath)) {
			try {
				const compressed = this.fs.readFileSync(filepath);
				const decompressed = await gunzipAsync(compressed);
				existingLines = decompressed.toString().split('\n').filter(line => line.trim());
			} catch (error) {
				vibeLog.warn('telemetryStorage', '[TelemetryStorage] Failed to read existing file:', error);
			}
		}

		// Append new events
		const newLines = events.map(event => JSON.stringify(event));
		const allLines = [...existingLines, ...newLines];
		const content = allLines.join('\n') + '\n';

		// Compress and write
		const compressed = await gzipAsync(Buffer.from(content, 'utf-8'));
		this.fs.writeFileSync(filepath, compressed);

		// Rotate old files if needed
		await this.rotateOldFiles();
	}

	/**
	 * Query events with filters
	 */
	async queryEvents(query: TelemetryQuery): Promise<AnyTelemetryEvent[]> {
		if (!this.fs) { return []; } // Browser context

		const results: AnyTelemetryEvent[] = [];
		const files = this._getTelemetryFiles();

		for (const file of files) {
			// Check if file is in time range
			if (query.timeRange) {
				const fileDate = this._extractDateFromFilename(file);
				if (fileDate < query.timeRange.start || fileDate > query.timeRange.end) {
					continue;
				}
			}

			try {
				const events = await this._readEventsFromFile(file);

				for (const event of events) {
					// Apply filters. Narrow on the `type` discriminator so variant-only
					// fields (`taskType`, `selectedModel`) are accessed type-safely.
					if (query.eventType && event.type !== query.eventType) { continue; }

					const hasTaskType = event.type === 'routing' || event.type === 'model_performance';
					if (query.taskType && (!hasTaskType || event.taskType !== query.taskType)) { continue; }

					const isRouting = event.type === 'routing';
					if (query.provider && (!isRouting || event.selectedModel.provider !== query.provider)) { continue; }
					if (query.modelName && (!isRouting || event.selectedModel.modelName !== query.modelName)) { continue; }
					if (query.isLocal !== undefined && (!isRouting || event.selectedModel.isLocal !== query.isLocal)) { continue; }

					results.push(event);

					if (query.limit && results.length >= query.limit) {
						return results;
					}
				}
			} catch (error) {
				vibeLog.warn('telemetryStorage', `[TelemetryStorage] Failed to read file ${file}:`, error);
			}
		}

		return results;
	}

	/**
	 * Read events from a single compressed file
	 */
	private async _readEventsFromFile(filepath: string): Promise<AnyTelemetryEvent[]> {
		if (!this.fs || !this.fs.existsSync(filepath)) { return []; }

		try {
			const compressed = this.fs.readFileSync(filepath);
			const decompressed = await gunzipAsync(compressed);
			const lines = decompressed.toString().split('\n').filter(line => line.trim());
			return lines.map(line => JSON.parse(line) as AnyTelemetryEvent);
		} catch (error) {
			vibeLog.warn('telemetryStorage', `[TelemetryStorage] Failed to read file ${filepath}:`, error);
			return [];
		}
	}

	/**
	 * Get all telemetry files sorted by date (newest first)
	 */
	private _getTelemetryFiles(): string[] {
		if (!this.fs || !this.fs.existsSync(this.storageDir)) { return []; }

		const files = this.fs.readdirSync(this.storageDir)
			.filter(f => f.startsWith('telemetry-') && f.endsWith('.jsonl.gz'))
			.map(f => path.join(this.storageDir, f))
			.sort((a, b) => {
				const dateA = this._extractDateFromFilename(a);
				const dateB = this._extractDateFromFilename(b);
				return dateB - dateA; // Newest first
			});

		return files;
	}

	/**
	 * Extract date timestamp from filename
	 */
	private _extractDateFromFilename(filepath: string): number {
		const filename = filepath.split(/[/\\]/).pop() || '';
		const match = filename.match(/telemetry-(\d{4}-\d{2}-\d{2})/);
		if (match) {
			return new Date(match[1]).getTime();
		}
		return 0;
	}

	/**
	 * Delete files older than retentionDays
	 */
	async rotateOldFiles(): Promise<void> {
		if (!this.fs) { return; } // Browser context

		const cutoffDate = Date.now() - (this.retentionDays * 24 * 60 * 60 * 1000);
		const files = this._getTelemetryFiles();

		for (const file of files) {
			const fileDate = this._extractDateFromFilename(file);
			if (fileDate < cutoffDate) {
				try {
					this.fs.unlinkSync(file);
				} catch (error) {
					vibeLog.warn('telemetryStorage', `[TelemetryStorage] Failed to delete old file ${file}:`, error);
				}
			}
		}

		// Check total size and compress/archive if needed
		await this._enforceStorageLimit();
	}

	/**
	 * Enforce storage size limit by compressing or deleting oldest files
	 */
	private async _enforceStorageLimit(): Promise<void> {
		if (!this.fs) { return; } // Browser context

		const files = this._getTelemetryFiles();
		let totalSize = 0;

		for (const file of files) {
			try {
				const stats = this.fs.statSync(file);
				totalSize += stats.size;
			} catch (error) {
				// File might have been deleted
			}
		}

		if (totalSize > this.maxStorageSize) {
			// Delete oldest files until under limit
			for (const file of files.reverse()) { // Start with oldest
				try {
					const stats = this.fs.statSync(file);
					if (totalSize <= this.maxStorageSize) { break; }

					this.fs.unlinkSync(file);
					totalSize -= stats.size;
				} catch (error) {
					// File might have been deleted
				}
			}
		}
	}

	/**
	 * Export telemetry for analysis
	 */
	async exportForAnalysis(format: 'csv' | 'json'): Promise<string> {
		const events = await this.queryEvents({});

		if (format === 'json') {
			return JSON.stringify(events, null, 2);
		}

		// CSV export (simplified - just routing events)
		const routingEvents = events.filter((e): e is RoutingDecisionEvent => e.type === 'routing');
		if (routingEvents.length === 0) { return ''; }

		const headers = [
			'timestamp', 'taskType', 'provider', 'modelName', 'isLocal',
			'confidence', 'totalLatency', 'tokensPerSecond', 'userAccepted',
			'userModified', 'editDistance', 'qualityScore'
		];

		const rows = routingEvents.map(event => [
			new Date(event.timestamp).toISOString(),
			event.taskType,
			event.selectedModel.provider,
			event.selectedModel.modelName,
			event.selectedModel.isLocal,
			event.routingConfidence,
			event.totalLatency,
			event.tokensPerSecond,
			event.userAccepted ?? '',
			event.userModified ?? '',
			event.editDistance ?? '',
			event.userAccepted ? (event.editDistance ? 1 - (event.editDistance / 100) : 1) : 0
		]);

		return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
	}

	/**
	 * Get storage statistics
	 */
	async getStorageStats(): Promise<{
		totalFiles: number;
		totalSize: number;
		oldestDate: number | null;
		newestDate: number | null;
	}> {
		if (!this.fs) {
			return { totalFiles: 0, totalSize: 0, oldestDate: null, newestDate: null };
		}

		const files = this._getTelemetryFiles();
		let totalSize = 0;
		let oldestDate: number | null = null;
		let newestDate: number | null = null;

		for (const file of files) {
			try {
				const stats = this.fs.statSync(file);
				totalSize += stats.size;
				const fileDate = this._extractDateFromFilename(file);
				if (!oldestDate || fileDate < oldestDate) { oldestDate = fileDate; }
				if (!newestDate || fileDate > newestDate) { newestDate = fileDate; }
			} catch (error) {
				// File might have been deleted
			}
		}

		return {
			totalFiles: files.length,
			totalSize,
			oldestDate,
			newestDate
		};
	}
}

