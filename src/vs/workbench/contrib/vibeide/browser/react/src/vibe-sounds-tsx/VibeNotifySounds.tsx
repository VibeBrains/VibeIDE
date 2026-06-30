/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../../../../common/vibeLog.js';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAccessor } from '../util/services.js';
import { VibeModalForm } from '../components/VibeModalForm.js';
import { Play, Square, Trash2, Upload, Scissors, Save } from 'lucide-react';
import Severity from '../../../../../../../base/common/severity.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { NOTIFY_DEFAULT_SOUND_IDS, NOTIFY_CUSTOM_MAX_DURATION_SEC, NOTIFY_EDITOR_MAX_INPUT_BYTES, type NotifyCustomSound } from '../../../vibeNotifySoundService.js';
import { encodeWavPcm16Mono } from '../../../../common/helpers/wavEncode.js';
import { notifyS } from '../vibe-settings-tsx/vibeSettingsRu.js';

/**
 * «VibeIDE Звуки» — resizable sound editor (brain menu → «VibeIDE Звуки»). Lists the bundled
 * defaults + user-saved customs (each previewable / selectable), and embeds a waveform trimmer:
 * load a track (≤20 MB), drag a ≤5s window over the waveform, preview it, and save the trimmed
 * mono WAV into the sounds folder. Every decode/read is guarded so a missing file never crashes.
 */

const WAVE_HEIGHT = 96;
const SOUND_KEY = 'vibeide.notify.sound';

const readVolume = (raw: unknown): number => (typeof raw === 'number' && isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.6);

/** Read a themed color from a CSS variable, with a fallback (canvas can't resolve CSS vars itself). */
const cssVar = (name: string, fallback: string): string => {
	try {
		const v = getComputedStyle(document.body).getPropertyValue(name).trim();
		return v || fallback;
	} catch { return fallback; }
};

/** Downmix a buffer slice [start,end) seconds to a single mono Float32 channel. */
const extractMono = (buffer: AudioBuffer, startSec: number, endSec: number): Float32Array => {
	const sr = buffer.sampleRate;
	const s0 = Math.max(0, Math.floor(startSec * sr));
	const s1 = Math.min(buffer.length, Math.floor(endSec * sr));
	const n = Math.max(0, s1 - s0);
	const out = new Float32Array(n);
	const channels = buffer.numberOfChannels;
	for (let c = 0; c < channels; c++) {
		const data = buffer.getChannelData(c);
		for (let i = 0; i < n; i++) { out[i] += data[s0 + i] / channels; }
	}
	return out;
};

export const VibeNotifySounds: React.FC = () => {
	const accessor = useAccessor();
	const modalService = accessor.get('IVibeNotifySoundsModalService');
	const soundService = accessor.get('IVibeNotifySoundService');
	const configService = accessor.get('IConfigurationService');
	const notificationService = accessor.get('INotificationService');

	const [open, setOpen] = useState<boolean>(() => modalService.isOpen);
	const [customs, setCustoms] = useState<NotifyCustomSound[]>([]);
	const [selected, setSelected] = useState<string>(() => configService.getValue<string>(`${SOUND_KEY}.sound`) ?? 'taskCompleted');
	const [customPath, setCustomPath] = useState<string>(() => configService.getValue<string>(`${SOUND_KEY}.customPath`) ?? '');

	// Editor state
	const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
	const [fileName, setFileName] = useState<string>('');
	const [sel, setSel] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
	const [canvasW, setCanvasW] = useState(0);
	const [saving, setSaving] = useState(false);
	const [previewing, setPreviewing] = useState(false);
	const [dragMode, setDragMode] = useState<null | 'move' | 'left' | 'right'>(null);

	const audioCtxRef = useRef<AudioContext | null>(null);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const previewSrcRef = useRef<AudioBufferSourceNode | null>(null);
	const dragRef = useRef<{ mode: 'move' | 'left' | 'right'; x: number; start: number; end: number } | null>(null);

	const ensureCtx = useCallback((): AudioContext | null => {
		if (!audioCtxRef.current) {
			try {
				const g = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext };
				const Ctor: typeof AudioContext | undefined = g.AudioContext ?? g.webkitAudioContext;
				audioCtxRef.current = Ctor ? new Ctor() : null;
			} catch { audioCtxRef.current = null; }
		}
		return audioCtxRef.current;
	}, []);

	const stopPreview = useCallback(() => {
		try { previewSrcRef.current?.stop(); } catch { /* already stopped */ }
		previewSrcRef.current = null;
		setPreviewing(false);
	}, []);

	useEffect(() => {
		const sub = modalService.onDidChangeOpen((v) => { setOpen(v); if (!v) { stopPreview(); } });
		return () => sub.dispose();
	}, [modalService, stopPreview]);

	useEffect(() => () => { try { void audioCtxRef.current?.close(); } catch { /* ignore */ } }, []);

	// Keep selection in sync with the persisted config (also when the Settings tab changes it).
	useEffect(() => {
		const d = configService.onDidChangeConfiguration(e => {
			if (!e.affectsConfiguration(SOUND_KEY)) { return; }
			setSelected(configService.getValue<string>(`${SOUND_KEY}.sound`) ?? 'taskCompleted');
			setCustomPath(configService.getValue<string>(`${SOUND_KEY}.customPath`) ?? '');
		});
		return () => d.dispose();
	}, [configService]);

	const refreshCustoms = useCallback(async () => {
		setCustoms(await soundService.listCustomSounds());
	}, [soundService]);

	useEffect(() => { if (open) { void refreshCustoms(); } }, [open, refreshCustoms]);

	const close = useCallback(() => modalService.close(), [modalService]);

	const set = useCallback(async (subKey: string, value: unknown) => {
		try { await configService.updateValue(`${SOUND_KEY}.${subKey}`, value); }
		catch (e: any) { notificationService.notify({ severity: Severity.Error, message: `${notifyS.sectionTitle}: ${e?.message ?? e}` }); }
	}, [configService, notificationService]);

	const selectDefault = (id: string) => { void set('sound', id); soundService.preview(id); };
	const selectCustom = (uri: URI) => { void set('customPath', uri.fsPath); void set('sound', 'custom'); soundService.preview(undefined, uri.fsPath); };

	const deleteCustom = useCallback(async (uri: URI) => {
		await soundService.deleteCustomSound(uri);
		if (selected === 'custom' && customPath === uri.fsPath) {
			await set('sound', 'taskCompleted');
			notificationService.info(notifyS.customDeletedReset);
		}
		await refreshCustoms();
	}, [soundService, selected, customPath, set, notificationService, refreshCustoms]);

	// ── Editor: load + decode ──────────────────────────────────────────────────
	const onFilePicked = useCallback(async (file: File) => {
		if (file.size > NOTIFY_EDITOR_MAX_INPUT_BYTES) {
			const mb = (NOTIFY_EDITOR_MAX_INPUT_BYTES / (1024 * 1024)).toFixed(0);
			notificationService.notify({ severity: Severity.Warning, message: notifyS.editorTooBig(mb) });
			return;
		}
		const ctx = ensureCtx();
		if (!ctx) { return; }
		stopPreview();
		try {
			const arr = await file.arrayBuffer();
			const decoded = await ctx.decodeAudioData(arr);
			setBuffer(decoded);
			setFileName(file.name);
			setSel({ start: 0, end: Math.min(decoded.duration, NOTIFY_CUSTOM_MAX_DURATION_SEC) });
		} catch (err) {
			vibeLog.warn('notifySound', `editor decode failed: ${err instanceof Error ? err.message : String(err)}`);
			notificationService.notify({ severity: Severity.Warning, message: notifyS.editorDecodeFail });
		}
	}, [ensureCtx, stopPreview, notificationService]);

	// ── Editor: measure canvas width (drives the seconds↔pixels mapping) ────────
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) { setCanvasW(0); return; }
		const update = () => setCanvasW(canvas.clientWidth);
		update();
		const ro = new ResizeObserver(update);
		ro.observe(canvas);
		return () => ro.disconnect();
	}, [buffer]);

	const pps = buffer && buffer.duration > 0 && canvasW > 0 ? canvasW / buffer.duration : 0;

	// ── Editor: draw waveform ──────────────────────────────────────────────────
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || !buffer || canvasW <= 0) { return; }
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		canvas.width = Math.floor(canvasW * dpr);
		canvas.height = Math.floor(WAVE_HEIGHT * dpr);
		const ctx2d = canvas.getContext('2d');
		if (!ctx2d) { return; }
		ctx2d.scale(dpr, dpr);
		ctx2d.clearRect(0, 0, canvasW, WAVE_HEIGHT);

		const data = buffer.getChannelData(0);
		const step = Math.max(1, Math.floor(data.length / canvasW));
		const mid = WAVE_HEIGHT / 2;
		ctx2d.strokeStyle = cssVar('--vscode-charts-blue', '#5b9bd5');
		ctx2d.globalAlpha = 0.9;
		ctx2d.beginPath();
		for (let x = 0; x < canvasW; x++) {
			let min = 1, max = -1;
			for (let i = 0; i < step; i++) {
				const v = data[x * step + i] ?? 0;
				if (v < min) { min = v; }
				if (v > max) { max = v; }
			}
			ctx2d.moveTo(x + 0.5, mid + min * mid);
			ctx2d.lineTo(x + 0.5, mid + max * mid);
		}
		ctx2d.stroke();
	}, [buffer, canvasW]);

	// ── Editor: selection drag (move + resize) via window listeners, ≤ max duration ──
	useEffect(() => {
		if (!dragMode) { return; }
		const onMove = (e: PointerEvent) => {
			const d = dragRef.current;
			if (!d || !buffer || pps <= 0) { return; }
			const deltaSec = (e.clientX - d.x) / pps;
			const dur = buffer.duration;
			const maxLen = Math.min(NOTIFY_CUSTOM_MAX_DURATION_SEC, dur);
			if (d.mode === 'move') {
				const len = d.end - d.start;
				const start = Math.max(0, Math.min(dur - len, d.start + deltaSec));
				setSel({ start, end: start + len });
			} else if (d.mode === 'left') {
				let start = Math.max(0, Math.min(d.end - 0.1, d.start + deltaSec));
				if (d.end - start > maxLen) { start = d.end - maxLen; }
				setSel({ start, end: d.end });
			} else {
				let end = Math.min(dur, Math.max(d.start + 0.1, d.end + deltaSec));
				if (end - d.start > maxLen) { end = d.start + maxLen; }
				setSel({ start: d.start, end });
			}
		};
		const onUp = () => { dragRef.current = null; setDragMode(null); };
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
		return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
	}, [dragMode, buffer, pps]);

	const startDrag = (mode: 'move' | 'left' | 'right') => (e: React.PointerEvent) => {
		e.preventDefault();
		e.stopPropagation();
		// The playing clip is the OLD window — stop it the moment the user starts moving/resizing.
		stopPreview();
		dragRef.current = { mode, x: e.clientX, start: sel.start, end: sel.end };
		setDragMode(mode);
	};

	// Click anywhere on the waveform → recenter the window on the click (keeps its length).
	const centerAt = (offsetX: number) => {
		if (!buffer || pps <= 0) { return; }
		stopPreview();
		const dur = buffer.duration;
		const len = Math.min((sel.end - sel.start) || NOTIFY_CUSTOM_MAX_DURATION_SEC, dur);
		const start = Math.max(0, Math.min(dur - len, offsetX / pps - len / 2));
		setSel({ start, end: start + len });
	};

	// ── Editor: preview ONLY the selected window; click again to stop ───────────
	const togglePreview = useCallback(() => {
		if (previewing) { stopPreview(); return; }
		if (!buffer) { return; }
		const ctx = ensureCtx();
		if (!ctx) { return; }
		const samples = extractMono(buffer, sel.start, sel.end);
		if (samples.length === 0) { return; }
		const mono = ctx.createBuffer(1, samples.length, buffer.sampleRate);
		mono.getChannelData(0).set(samples);
		const src = ctx.createBufferSource();
		src.buffer = mono;
		const gain = ctx.createGain();
		gain.gain.value = readVolume(configService.getValue<number>(`${SOUND_KEY}.volume`));
		src.connect(gain);
		gain.connect(ctx.destination);
		src.onended = () => { if (previewSrcRef.current === src) { previewSrcRef.current = null; setPreviewing(false); } };
		src.start();
		previewSrcRef.current = src;
		setPreviewing(true);
	}, [previewing, stopPreview, buffer, sel, ensureCtx, configService]);

	const saveSelection = useCallback(async () => {
		if (!buffer || saving) { return; }
		setSaving(true);
		try {
			const samples = extractMono(buffer, sel.start, sel.end);
			if (samples.length === 0) { return; }
			const bytes = encodeWavPcm16Mono(samples, buffer.sampleRate);
			const stem = (fileName.replace(/\.[^.]+$/, '') || 'sound').slice(0, 60);
			const target = await soundService.saveCustomSound(`${stem}-trim.wav`, bytes);
			await refreshCustoms();
			await set('customPath', target.fsPath);
			await set('sound', 'custom');
			notificationService.info(notifyS.editorSaved);
		} catch (err) {
			vibeLog.warn('notifySound', `editor save failed: ${err instanceof Error ? err.message : String(err)}`);
			notificationService.notify({ severity: Severity.Error, message: notifyS.editorSaveFail });
		} finally {
			setSaving(false);
		}
	}, [buffer, saving, sel, fileName, soundService, refreshCustoms, set, notificationService]);

	// ── Render ──────────────────────────────────────────────────────────────────
	const soundRow = (key: string, label: string, isSelected: boolean, onSelect: () => void, onPreview: () => void, onDelete?: () => void, sub?: string) => (
		<div
			key={key}
			className={`flex items-center justify-between gap-3 px-3 py-2 rounded-md cursor-pointer select-none border ${isSelected ? 'border-[var(--vscode-focusBorder)] bg-[var(--vscode-list-hoverBackground)]' : 'border-transparent hover:bg-[var(--vscode-list-hoverBackground)]'}`}
			onClick={onSelect}
		>
			<div className='flex items-center gap-2 min-w-0'>
				<span className={`shrink-0 size-3 rounded-full border ${isSelected ? 'border-[var(--vscode-focusBorder)] bg-[var(--vscode-focusBorder)]' : 'border-vibe-fg-3'}`} />
				<span className='text-sm text-vibe-fg-1 truncate'>{label}</span>
				{sub && <span className='text-xs text-vibe-fg-4 truncate'>{sub}</span>}
			</div>
			<div className='flex items-center gap-1 shrink-0'>
				<button type='button' className='p-1 rounded hover:bg-[var(--vscode-toolbar-hoverBackground)] text-vibe-fg-2'
					onClick={(e) => { e.stopPropagation(); onPreview(); }} title={notifyS.previewTooltip} aria-label={notifyS.previewTooltip}>
					<Play size={14} />
				</button>
				{onDelete && (
					<button type='button' className='p-1 rounded hover:bg-[var(--vscode-toolbar-hoverBackground)] text-[var(--vscode-errorForeground)]'
						onClick={(e) => { e.stopPropagation(); onDelete(); }} title={notifyS.deleteTooltip} aria-label={notifyS.deleteTooltip}>
						<Trash2 size={14} />
					</button>
				)}
			</div>
		</div>
	);

	return (
		<VibeModalForm open={open} title={notifyS.modalTitle} onClose={close} defaultWidth={680} defaultHeight={620}>
			<div className='@@vibe-scope flex flex-col gap-5'>
				{/* Sound list */}
				<div>
					<h3 className='text-base font-medium text-vibe-fg-1 mb-2'>{notifyS.soundTitle}</h3>
					<div className='flex flex-col gap-1'>
						{NOTIFY_DEFAULT_SOUND_IDS.map(id =>
							soundRow(id, notifyS.soundNames[id] ?? id, selected === id, () => selectDefault(id), () => soundService.preview(id))
						)}
						{customs.map(c =>
							soundRow(`custom:${c.uri.toString()}`, c.name, selected === 'custom' && customPath === c.uri.fsPath,
								() => selectCustom(c.uri), () => soundService.preview(undefined, c.uri.fsPath), () => void deleteCustom(c.uri), notifyS.customBadge)
						)}
						{customs.length === 0 && <div className='text-xs text-vibe-fg-4 px-3 py-1'>{notifyS.noCustoms}</div>}
					</div>
				</div>

				{/* Editor */}
				<div className='border-t border-vibe-border-4 pt-4'>
					<h3 className='text-base font-medium text-vibe-fg-1 mb-1'>{notifyS.editorTitle}</h3>
					<p className='text-xs text-vibe-fg-3 mb-2'>{notifyS.editorHint(NOTIFY_CUSTOM_MAX_DURATION_SEC, (NOTIFY_EDITOR_MAX_INPUT_BYTES / (1024 * 1024)).toFixed(0))}</p>

					<input ref={fileInputRef} type='file' accept='.mp3,.ogg,.wav,audio/*' className='hidden'
						onChange={(e) => { const f = e.target.files?.[0]; if (f) { void onFilePicked(f); } e.target.value = ''; }} />
					<button type='button' className='@@vibe-pill-button @@vibe-pill-button--primary text-xs inline-flex items-center gap-1.5 mb-3'
						onClick={() => fileInputRef.current?.click()}>
						<Upload size={14} /> {notifyS.editorLoad}
					</button>

					{buffer && (
						<>
							{/* Scrubber: a wide, easy-to-grab handle (= window width) dragged along the whole track. */}
							<div className='relative w-full mb-2 rounded select-none' style={{ height: 16, backgroundColor: cssVar('--vscode-editorWidget-background', 'rgba(255,255,255,0.06)') }}>
								<div
									className='absolute top-0 bottom-0 rounded cursor-grab'
									style={{ left: sel.start * pps, width: Math.max(12, (sel.end - sel.start) * pps), backgroundColor: cssVar('--vscode-focusBorder', '#4daafc'), opacity: 0.85 }}
									onPointerDown={startDrag('move')}
									title={notifyS.editorScrubTip}
								/>
							</div>

							<div className='relative w-full select-none' style={{ height: WAVE_HEIGHT }}>
								<canvas ref={canvasRef} className='w-full h-full block rounded bg-[var(--vscode-editor-background)] cursor-crosshair' style={{ height: WAVE_HEIGHT }} onClick={(e) => centerAt(e.nativeEvent.offsetX)} />
								{/* Selection overlay — translucent themed fill + grab edges */}
								<div
									className='absolute top-0 bottom-0 cursor-move'
									style={{
										left: sel.start * pps,
										width: Math.max(2, (sel.end - sel.start) * pps),
										backgroundColor: cssVar('--vscode-editor-selectionBackground', 'rgba(90,155,213,0.35)'),
										boxShadow: `inset 2px 0 0 ${cssVar('--vscode-focusBorder', '#4daafc')}, inset -2px 0 0 ${cssVar('--vscode-focusBorder', '#4daafc')}`,
									}}
									onPointerDown={startDrag('move')}
								>
									<div className='absolute left-[-4px] top-0 bottom-0 w-2 cursor-ew-resize' onPointerDown={startDrag('left')} />
									<div className='absolute right-[-4px] top-0 bottom-0 w-2 cursor-ew-resize' onPointerDown={startDrag('right')} />
								</div>
							</div>

							<div className='flex items-center gap-3 mt-2 flex-wrap'>
								<span className='text-xs text-vibe-fg-3 tabular-nums'>{notifyS.editorSelection(sel.start.toFixed(2), sel.end.toFixed(2), (sel.end - sel.start).toFixed(2))}</span>
								<button type='button' className='@@vibe-pill-button text-xs inline-flex items-center gap-1.5' onClick={togglePreview}>
									{previewing ? <><Square size={14} /> {notifyS.editorStop}</> : <><Play size={14} /> {notifyS.editorPreview}</>}
								</button>
								<button type='button' className='@@vibe-pill-button @@vibe-pill-button--primary text-xs inline-flex items-center gap-1.5 disabled:opacity-50'
									disabled={saving || sel.end - sel.start < 0.05} onClick={() => void saveSelection()}>
									{saving ? <Scissors size={14} className='animate-pulse' /> : <Save size={14} />} {notifyS.editorSave}
								</button>
							</div>
						</>
					)}
				</div>
			</div>
		</VibeModalForm>
	);
};
