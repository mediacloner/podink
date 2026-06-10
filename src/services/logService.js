/**
 * logService — lightweight in-memory + persisted debug logger.
 *
 * Usage:
 *   import { log, getLogs, clearLogs, isLoggingEnabled, setLoggingEnabled } from './logService';
 *
 *   log('UI', 'Transcribe tapped', { episodeId: 42 });
 *   log('SERVICE', 'Queue enqueue', { id: 42, queueLen: 3 });
 *
 * Categories:
 *   UI       — button taps, navigation, screen focus
 *   SERVICE  — whisper queue: enqueue, dequeue, start, complete, fail, abort
 *   QUEUE    — queue snapshots (activeId, queuedIds, processing flag)
 *   SYSTEM   — app state changes, foreground service, model init
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY  = '@debug_logs_v1';
const ENABLED_KEY  = '@debug_logging_enabled';
const MAX_ENTRIES  = 500;

let _enabled  = false;
let _logs     = [];     // { ts, cat, msg, data? }
let _listeners = new Set();

// ─── Internal (must be declared before public API uses them) ─────────────────

// Synchronous notify — only used by setLoggingEnabled / clearLogs (user actions).
const _notify = () => { const fns = [..._listeners]; fns.forEach(fn => fn()); };

// Deferred notify — used by log() to avoid a synchronous cascade:
// whisperService._notify → syncQueue → log() → logService._notify → React setState
// That chain floods the native bridge and causes ConcurrentModificationException.
let _notifyTimer = null;
const _notifyDeferred = () => {
    if (_notifyTimer) return;
    _notifyTimer = setTimeout(() => {
        _notifyTimer = null;
        const fns = [..._listeners];
        fns.forEach(fn => fn());
    }, 100);
};

let _persistTimer = null;
const _persistDebounced = () => {
    if (_persistTimer) return;
    _persistTimer = setTimeout(() => {
        _persistTimer = null;
        AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(_logs)).catch(() => {});
    }, 2000);
};

// ─── Public API ──────────────────────────────────────────────────────────────

export const isLoggingEnabled = () => _enabled;

export const setLoggingEnabled = async (on) => {
    _enabled = on;
    await AsyncStorage.setItem(ENABLED_KEY, JSON.stringify(on)).catch(() => {});
    // When turning off, wipe all logs from memory and storage
    if (!on) {
        _logs = [];
        await AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
    }
    _notify();
};

export const log = (category, message, data) => {
    if (!_enabled) return;
    const entry = {
        ts: Date.now(),
        cat: category,
        msg: message,
        ...(data !== undefined && data !== null ? { data } : {}),
    };
    _logs.push(entry);
    if (_logs.length > MAX_ENTRIES) _logs = _logs.slice(-MAX_ENTRIES);
    _persistDebounced();
    _notifyDeferred();
};

export const getLogs = () => _logs;

export const clearLogs = async () => {
    _logs = [];
    await AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
    _notify();
};

export const onLogsChange = (fn) => {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
};

/**
 * Export logs as a JSON string suitable for sharing.
 */
export const exportLogsAsText = () => {
    return JSON.stringify(_logs, null, 2);
};

// ─── Restore on startup ─────────────────────────────────────────────────────

export const restoreLogs = async () => {
    try {
        const enabledRaw = await AsyncStorage.getItem(ENABLED_KEY);
        if (enabledRaw !== null) _enabled = JSON.parse(enabledRaw);
    } catch (_) {}
    try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) _logs = JSON.parse(raw);
    } catch (_) {}
};
