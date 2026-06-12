import React, {
    forwardRef, useCallback, useEffect, useImperativeHandle,
    useMemo, useRef, useState,
} from 'react';
import {
    ActivityIndicator, FlatList, InteractionManager, Platform, Pressable,
    StyleSheet, Text, View, useWindowDimensions,
} from 'react-native';
import Animated, {
    cancelAnimation,
    Easing,
    interpolate,
    interpolateColor,
    runOnJS,
    runOnUI,
    scrollTo,
    useAnimatedReaction,
    useAnimatedRef,
    useAnimatedScrollHandler,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import TrackPlayer from 'react-native-track-player';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { Feather as Icon } from '@expo/vector-icons';
import { colors, radii, withAlpha } from '../theme';
import PositionFeeder from './transcript/PositionFeeder';
import TranslationModal from './transcript/TranslationModal';
import WordPopover from './transcript/WordPopover';
import FollowPill from './transcript/FollowPill';

// ─── Constants ───────────────────────────────────────────────────────────────

const CHUNK_MARGIN = 10;                 // matches sentenceWrap.marginBottom
const DEFAULT_FONT_SIZE = 22;
const LOOKAHEAD_MS = 550;                // scaled by playback rate on the UI thread
const WORD_LEVEL_RADIUS = 1;             // prev + current + next chunk → word-by-word
const KEYPOINT_INTERVAL_MS = 10 * 60 * 1000;
const KEYPOINT_HEIGHT = 36;              // fixed — used in both layout and scroll math
const SEEK_CHUNK_GAP = 3;                // chunk jumps larger than this fade-snap
const FOLLOW_ANCHOR = 0.40;              // active chunk midpoint sits at 40% of viewport
const TOP_PAD = 28;                      // ListHeader height, baked into item offsets
const VIGNETTE_TOP_H = 110;
const VIGNETTE_BOT_H = 130;

const LIST_HEADER = <View style={{ height: TOP_PAD }} />;
const CHUNK_RIPPLE = { color: withAlpha(colors.accent, 0.12), foreground: true };

// Animated.FlatList silently overrides CellRendererComponent with its own
// itemLayoutAnimation wrapper (props spread first, its cell renderer last) —
// wrap FlatList directly so ours reaches VirtualizedList. scrollTo() +
// useAnimatedScrollHandler work the same on any createAnimatedComponent list.
const AnimatedFlatList = Animated.createAnimatedComponent(FlatList);

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function formatTime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sc = s % 60;
    return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(sc).padStart(2, '0')}`
        : `${m}:${String(sc).padStart(2, '0')}`;
}

// Estimate the rendered height of a chunk from its word list. Used as the
// initial getItemLayout value until the cell reports its real onLayout height.
function estimateChunkHeight(words, charWidth, contentWidth, lineHeight) {
    const chars = words.reduce((n, w) => n + w.text.length, 0);
    const lines = Math.max(1, Math.ceil((chars * charWidth) / contentWidth));
    return lines * lineHeight;
}

const clampPercent = (p) => Math.min(100, Math.max(0, Math.round(p || 0)));

// Stable identity for the "no transcript yet" computed state so the FlatList
// doesn't keep tearing down/up its internal data when segments are empty.
// Word timings live in parallel typed arrays: TypedArrays cross to the UI
// runtime as a single ArrayBuffer memcpy instead of per-element clones.
const EMPTY_COMPUTED = Object.freeze({
    chunks: [],
    displayItems: [],
    chunkToDisplay: new Int32Array(0),
    wordStarts: new Float64Array(0),
    wordChunks: new Int32Array(0),
});

const keyExtractor = (item) => item.id;

// ─── Component ────────────────────────────────────────────────────────────────

const TranscriptHighlighter = forwardRef(({
    segments,
    fadeTo = colors.bgPlayer,
    loading = false,
    hasTranscript = false,
    canTranscribe = false,
    onTranscribe,
    transcribing = false,
    isQueued = false,
    transcribeProgress = 0,
    playbackRate = 1,
    episodeId,
    episodeTitle,
}, ref) => {
    const isFocused = useIsFocused();
    const { width: windowWidth } = useWindowDimensions();
    const contentWidth = windowWidth - 48; // paddingHorizontal: 24 * 2

    // ── User prefs (re-read on every screen focus) ────────────────────────────
    const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
    const [translationLang, setTranslationLang] = useState('es');
    useFocusEffect(useCallback(() => {
        let alive = true;
        AsyncStorage.multiGet(['@transcript_font_size', '@translation_lang'])
            .then(pairs => {
                if (!alive) return;
                const size = parseInt(pairs?.[0]?.[1], 10);
                setFontSize(Number.isFinite(size) && size > 0 ? size : DEFAULT_FONT_SIZE);
                setTranslationLang(pairs?.[1]?.[1] || 'es');
            })
            .catch(() => {});
        return () => { alive = false; };
    }, []));

    const lineHeight = Math.round(fontSize * 1.27);
    const charWidth = fontSize * 0.52;

    // useAnimatedRef() instead of useRef() — required for Reanimated's scrollTo worklet.
    const flatListRef = useAnimatedRef();

    // ── SharedValues — the entire playback→highlight→scroll path is UI-thread ─
    const positionMsSV = useSharedValue(0);     // fed by PositionFeeder (ms)
    const isPlayingSV = useSharedValue(0);      // 1 playing · 0 paused
    const rateSV = useSharedValue(1);
    const activeIndexSV = useSharedValue(-1);   // global word index
    const activeChunkSV = useSharedValue(-1);
    const opacitySV = useSharedValue(1);        // fade-out/in on big seeks
    const scrollYSV = useSharedValue(0);        // programmatic scroll driver
    const scrollOffsetSV = useSharedValue(0);   // real list offset (user + auto)
    const followSV = useSharedValue(1);         // 1 follow on · 0 off
    const isTouchingSV = useSharedValue(0);
    const lastScrollTargetSV = useSharedValue(0);
    const activeTargetYSV = useSharedValue(-1); // centered scroll target of active chunk
    const fadeGenSV = useSharedValue(0);        // generation of the current fade-snap
    const viewportHSV = useSharedValue(600);
    const contentHSV = useSharedValue(0);       // real content height — end clamps
    const deadZoneSV = useSharedValue(42);
    const wordStartsSV = useSharedValue(EMPTY_COMPUTED.wordStarts);
    const wordChunksSV = useSharedValue(EMPTY_COMPUTED.wordChunks);
    const chunkToDisplaySV = useSharedValue(EMPTY_COMPUTED.chunkToDisplay);
    const itemOffsetsSV = useSharedValue(new Float64Array(0));
    const trueYSV = useSharedValue(new Float64Array(0));   // measured cell tops, NaN = never mounted
    const trueHSV = useSharedValue(new Float64Array(0));   // measured cell heights, NaN = never mounted
    const pendingCorrectionSV = useSharedValue(-1);        // display index awaiting settle-correction

    useEffect(() => {
        rateSV.value = playbackRate > 0 ? playbackRate : 1;
    }, [playbackRate, rateSV]);

    useEffect(() => {
        // How far the active chunk must drift before re-centering — about 1.5 lines.
        deadZoneSV.value = lineHeight * 1.5;
    }, [lineHeight, deadZoneSV]);

    // ── Episode change reset ──────────────────────────────────────────────────
    // This component stays mounted across episode switches (PlayerScreen reuses
    // the same Player route), so every SharedValue persists. Reset the follow +
    // playback-position + scroll-driver state so episode B doesn't inherit
    // episode A's dragged-off follow state, stale playhead, or mid-fade dimmed
    // list. Ordered before the build effect so it wins the race with a fast
    // rebuild. The list remounts at offset 0 (the empty-state path unmounts it
    // when PlayerScreen clears segments), so scrollOffsetSV=0 matches reality.
    useEffect(() => {
        followSV.value = 1;
        positionMsSV.value = 0;
        activeTargetYSV.value = -1;
        lastScrollTargetSV.value = 0;
        activeChunkSV.value = -1;
        activeIndexSV.value = -1;
        pendingCorrectionSV.value = -1;
        cancelAnimation(scrollYSV);
        scrollOffsetSV.value = 0;
        scrollYSV.value = 0;
        opacitySV.value = 1;
    }, [
        episodeId, followSV, positionMsSV, activeTargetYSV, lastScrollTargetSV,
        activeChunkSV, activeIndexSV, pendingCorrectionSV, scrollYSV,
        scrollOffsetSV, opacitySV,
    ]);

    // ── Build chunk data (async, batched) ────────────────────────────────────
    //
    // For long episodes (75-min ≈ 67k word segments) a synchronous build pegs
    // the JS thread for seconds. Build in batches yielding between them, then
    // publish all derived state atomically. Rebuilds during live transcription
    // reuse the same path: chunk ids are deterministic for a stable prefix, so
    // FlatList keeps its scroll position and follow state is untouched.
    const [computed, setComputed] = useState(EMPTY_COMPUTED);
    const [isBuilding, setIsBuilding] = useState(false);
    const { displayItems } = computed;

    useEffect(() => {
        if (!segments?.length) {
            setComputed(EMPTY_COMPUTED);
            setIsBuilding(false);
            return;
        }

        let cancelled = false;
        setIsBuilding(true);

        const BATCH = 5000;
        const builtChunks = [];
        let cur = [], chunkStartMs = 0, gi = 0;
        let i = 0;

        const buildChunksBatch = () => {
            if (cancelled) return;
            const end = Math.min(i + BATCH, segments.length);
            for (; i < end; i++) {
                const seg = segments[i];
                const raw = seg.text?.trim();
                if (!raw) continue;
                const sMs = seg.start_time ?? seg.start ?? 0;
                const eMs = seg.end_time ?? seg.end ?? sMs + 2000;
                const ws = raw.split(/\s+/).filter(Boolean);

                const totalUnits = ws.reduce((sum, w) => sum + w.length + 1, 0) || 1;
                const dur = eMs - sMs;
                let unitsSoFar = 0;

                for (let wi = 0; wi < ws.length; wi++) {
                    const w = ws[wi];
                    const wordStartMs = sMs + (unitsSoFar / totalUnits) * dur;
                    unitsSoFar += w.length + 1;

                    if (!cur.length) chunkStartMs = wordStartMs;
                    cur.push({ text: w + ' ', startMs: wordStartMs, globalIndex: gi++ });

                    const last = wi === ws.length - 1;
                    const sent = w.endsWith('.') || w.endsWith('?') || w.endsWith('!');
                    if (sent || cur.length >= 35 || (i === segments.length - 1 && last)) {
                        builtChunks.push({
                            id: `c${builtChunks.length}`,
                            words: cur,
                            startMs: chunkStartMs,
                            chunkIndex: builtChunks.length,
                        });
                        cur = [];
                    }
                }
            }

            if (i < segments.length) {
                setTimeout(buildChunksBatch, 0); // yield one task tick
                return;
            }

            // Derive display rows + word timing arrays in one pass.
            const _displayItems = [];
            let nextKp = KEYPOINT_INTERVAL_MS;
            for (const chunk of builtChunks) {
                while (chunk.startMs >= nextKp) {
                    _displayItems.push({
                        type: 'keypoint',
                        id: `kp${nextKp}`,
                        timeMs: nextKp,
                        label: formatTime(nextKp),
                    });
                    nextKp += KEYPOINT_INTERVAL_MS;
                }
                _displayItems.push({ type: 'chunk', ...chunk });
            }

            const _chunkToDisplay = new Int32Array(builtChunks.length);
            for (let j = 0; j < _displayItems.length; j++) {
                const item = _displayItems[j];
                if (item.type === 'chunk') _chunkToDisplay[item.chunkIndex] = j;
            }

            const _wordStarts = new Float64Array(gi);
            const _wordChunks = new Int32Array(gi);
            for (const ch of builtChunks) {
                for (const w of ch.words) {
                    _wordStarts[w.globalIndex] = w.startMs;
                    _wordChunks[w.globalIndex] = ch.chunkIndex;
                }
            }

            if (cancelled) return;
            setComputed({
                chunks: builtChunks,
                displayItems: _displayItems,
                chunkToDisplay: _chunkToDisplay,
                wordStarts: _wordStarts,
                wordChunks: _wordChunks,
            });
            setIsBuilding(false);
        };

        // Wait for the player open animation to settle before hogging the JS thread.
        const handle = InteractionManager.runAfterInteractions(buildChunksBatch);

        return () => {
            cancelled = true;
            if (handle?.cancel) handle.cancel();
        };
    }, [segments]);

    // ── Measured layout — estimates first, real onLayout heights as they land ─
    //
    // lengths/offsets live in refs (getItemLayout reads them without re-renders)
    // and offsets are mirrored into a Float64Array SharedValue for the UI-thread
    // scroll math. Each mirror is a whole-array swap (single memcpy), debounced
    // ~100ms, so the worklet never sees a partially updated array.
    const computedRef = useRef(EMPTY_COMPUTED);
    const layoutRef = useRef({ lengths: [], offsets: [], measured: new Map(), trueLayout: new Map(), metricsKey: '', flushTimer: null });
    const metricsRef = useRef({ charWidth, contentWidth, lineHeight });
    metricsRef.current = { charWidth, contentWidth, lineHeight };

    const recomputeOffsets = useCallback(() => {
        const st = layoutRef.current;
        const items = computedRef.current.displayItems;
        const m = metricsRef.current;
        const lengths = new Array(items.length);
        const offsets = new Array(items.length);
        let y = TOP_PAD;
        for (let j = 0; j < items.length; j++) {
            const item = items[j];
            offsets[j] = y;
            const len = st.measured.get(item.id)
                ?? (item.type === 'keypoint'
                    ? KEYPOINT_HEIGHT + CHUNK_MARGIN
                    : estimateChunkHeight(item.words, m.charWidth, m.contentWidth, m.lineHeight) + CHUNK_MARGIN);
            lengths[j] = len;
            y += len;
        }
        st.lengths = lengths;
        st.offsets = offsets;
        itemOffsetsSV.value = Float64Array.from(offsets);
    }, [itemOffsetsSV]);

    // True content-relative cell positions, captured by the CellRenderer
    // wrapper below. Prefix-sum offsets drift wherever cells above the target
    // were never mounted (estimates), but a cell's own layout.y inside the
    // FlatList content IS the coordinate scrollTo() addresses — auto-scroll
    // prefers it whenever available. NaN marks never-measured cells.
    const mirrorTrueLayout = useCallback(() => {
        const st = layoutRef.current;
        const items = computedRef.current.displayItems;
        const ys = new Float64Array(items.length);
        const hs = new Float64Array(items.length);
        for (let j = 0; j < items.length; j++) {
            const rec = st.trueLayout.get(items[j].id);
            ys[j] = rec ? rec.y : NaN;
            hs[j] = rec ? rec.h : NaN;
        }
        trueYSV.value = ys;
        trueHSV.value = hs;
    }, [trueYSV, trueHSV]);

    useEffect(() => {
        computedRef.current = computed;
        const st = layoutRef.current;
        // Include episodeId: chunk/keypoint ids (c0.., kp..) are identical across
        // episodes, so without it the previous episode's measured/true geometry
        // would be resurrected for same-id items and poison scroll targets. The
        // key stays stable during same-episode streaming rebuilds.
        const key = `${episodeId}:${fontSize}:${contentWidth}`;
        if (st.metricsKey !== key) {
            // Font size / width / episode changed — every measured height is stale.
            st.metricsKey = key;
            st.measured.clear();
            st.trueLayout.clear();
        }
        // Offsets must be on the UI thread before word timings land, so the
        // chunk reaction below never scrolls against stale geometry.
        recomputeOffsets();
        mirrorTrueLayout();
        chunkToDisplaySV.value = computed.chunkToDisplay;
        wordChunksSV.value = computed.wordChunks;
        wordStartsSV.value = computed.wordStarts;
    }, [computed, episodeId, fontSize, contentWidth, recomputeOffsets, mirrorTrueLayout, chunkToDisplaySV, wordChunksSV, wordStartsSV]);

    useEffect(() => () => clearTimeout(layoutRef.current.flushTimer), []);

    const getItemLayout = useCallback((_, index) => {
        const st = layoutRef.current;
        return {
            length: st.lengths[index] ?? 65,
            offset: st.offsets[index] ?? TOP_PAD + index * 65,
            index,
        };
    }, []);

    // ── Viewport (the transcript pane, NOT the screen) ────────────────────────
    const [viewportH, setViewportH] = useState(0);
    const onViewportLayout = useCallback((e) => {
        const h = e.nativeEvent.layout.height;
        setViewportH(h);
        viewportHSV.value = h;
    }, [viewportHSV]);

    const onContentSizeChange = useCallback((_w, h) => {
        contentHSV.value = h;
    }, [contentHSV]);

    const listFooter = useMemo(
        () => <View style={{ height: Math.max(viewportH * 0.55, 220) }} />,
        [viewportH],
    );

    // ── UI-thread scroll plumbing ─────────────────────────────────────────────

    // scrollYSV is the programmatic driver: every change is pushed to the list.
    useAnimatedReaction(
        () => scrollYSV.value,
        (y, prev) => {
            // prev is null on the very first call, before the FlatList ref is
            // attached — skip it to avoid the "uninitialized ref" error.
            if (prev === null) return;
            scrollTo(flatListRef, 0, y, false);
        },
    );

    // Animated advance or fade-snap to a target offset. UI-thread only.
    const scrollToTarget = useCallback((target, snap) => {
        'worklet';
        lastScrollTargetSV.value = target;
        if (snap) {
            cancelAnimation(scrollYSV);
            // Generation guard: a cancelled fade-out's callback(false) runs on a
            // LATER rAF, one frame after a replacement snap has already installed
            // its own fade-out on opacitySV. Without the guard the stale callback's
            // `opacitySV.value = 1` plain-write cancels the replacement's fade-out,
            // so its finished branch never jumps the list. Claim the generation,
            // and only act in the callback if we still own it.
            const gen = ++fadeGenSV.value;
            opacitySV.value = withTiming(0, { duration: 120 }, (finished) => {
                if (fadeGenSV.value !== gen) return; // a newer snap owns opacitySV now
                if (finished) {
                    scrollYSV.value = target;
                    opacitySV.value = withTiming(1, { duration: 200, easing: Easing.out(Easing.quad) });
                } else {
                    opacitySV.value = 1; // genuine interruption with no successor — restore
                }
            });
        } else {
            scrollYSV.value = withTiming(target, {
                duration: 900,
                easing: Easing.out(Easing.cubic),
            });
        }
    }, [lastScrollTargetSV, scrollYSV, opacitySV, fadeGenSV]);

    // Anchor a cell's midpoint at FOLLOW_ANCHOR of the viewport, clamped to
    // valid scroll range. contentHSV is 0 until onContentSizeChange lands —
    // skip the end clamp until then.
    const computeTarget = useCallback((y, h) => {
        'worklet';
        const vh = viewportHSV.value;
        let target = y + h * 0.5 - vh * FOLLOW_ANCHOR;
        const contentH = contentHSV.value;
        if (contentH > vh) target = Math.min(target, contentH - vh);
        return Math.max(0, target);
    }, [viewportHSV, contentHSV]);

    // Settle-correction: a far seek scrolls against estimated offsets; once
    // the target cell's true layout lands (debounced flush), re-aim ONCE with
    // the corrected value. The token is consumed before scrolling, so the
    // correction can never cascade.
    const maybeCorrect = useCallback(() => {
        'worklet';
        const di = pendingCorrectionSV.value;
        if (di < 0) return;
        if (isTouchingSV.value === 1) return; // never under a finger — retry on a later flush
        if (followSV.value !== 1) {
            pendingCorrectionSV.value = -1;
            return;
        }
        const ci = activeChunkSV.value;
        const map = chunkToDisplaySV.value;
        if (ci < 0 || ci >= map.length || map[ci] !== di) {
            // Active chunk moved on — its own reaction re-targets with fresh data.
            pendingCorrectionSV.value = -1;
            return;
        }
        const ys = trueYSV.value;
        if (di >= ys.length || isNaN(ys[di])) return; // truth not in yet — keep the token
        pendingCorrectionSV.value = -1;
        const hs = trueHSV.value;
        const target = computeTarget(ys[di], isNaN(hs[di]) ? 0 : hs[di]);
        activeTargetYSV.value = target;
        if (Math.abs(target - scrollOffsetSV.value) > deadZoneSV.value) {
            scrollYSV.value = scrollOffsetSV.value; // animate from the real position
            scrollToTarget(target, false);
        }
    }, [
        pendingCorrectionSV, isTouchingSV, followSV, activeChunkSV, chunkToDisplaySV,
        trueYSV, trueHSV, computeTarget, activeTargetYSV, scrollOffsetSV, deadZoneSV,
        scrollYSV, scrollToTarget,
    ]);

    // One debounced flush serves both layout feeds (estimate heights + true
    // positions), then lets the UI thread settle-correct against fresh truth.
    const scheduleLayoutFlush = useCallback(() => {
        const st = layoutRef.current;
        if (st.flushTimer) return;
        st.flushTimer = setTimeout(() => {
            st.flushTimer = null;
            recomputeOffsets();
            mirrorTrueLayout();
            runOnUI(maybeCorrect)();
        }, 100);
    }, [recomputeOffsets, mirrorTrueLayout, maybeCorrect]);

    const onCellLayout = useCallback((index, id, height) => {
        const st = layoutRef.current;
        const len = Math.round(height) + CHUNK_MARGIN;
        if (st.measured.get(id) === len) return;
        st.measured.set(id, len);
        scheduleLayoutFlush();
    }, [scheduleLayoutFlush]);

    const onCellTrueLayout = useCallback((id, layout) => {
        const st = layoutRef.current;
        const prev = st.trueLayout.get(id);
        if (prev && prev.y === layout.y && prev.h === layout.height) return;
        st.trueLayout.set(id, { y: layout.y, h: layout.height });
        scheduleLayoutFlush();
    }, [scheduleLayoutFlush]);

    // Thin pass-through over VirtualizedList's cell. Its layout.y is relative
    // to the FlatList content container — the truth the scroll math needs.
    // All injected props (style, onFocusCapture, children, cellKey, index) are
    // forwarded untouched. VirtualizedList only injects its own onLayout when
    // it listens for cell layouts (debug / fill-rate / missing getItemLayout);
    // compose it anyway so those metrics keep flowing if ever enabled.
    const cellTrueLayoutRef = useRef(onCellTrueLayout);
    cellTrueLayoutRef.current = onCellTrueLayout;
    const CellRenderer = useMemo(() => {
        const TranscriptCell = ({ item, onLayout, ...rest }) => {
            const handleLayout = useCallback((e) => {
                cellTrueLayoutRef.current(item.id, e.nativeEvent.layout);
                if (onLayout) onLayout(e);
            }, [item.id, onLayout]);
            return <View {...rest} onLayout={handleLayout} />;
        };
        return TranscriptCell;
    }, []);

    // ── Active word/chunk: binary search on the UI thread ────────────────────
    // Touching wordStartsSV in the prepare closure makes a finished build
    // re-trigger this even while paused, so the initial highlight + centering
    // appear without waiting for a position tick.
    useAnimatedReaction(
        () => ({
            posMs: positionMsSV.value + LOOKAHEAD_MS * rateSV.value,
            count: wordStartsSV.value.length,
        }),
        (cur) => {
            const starts = wordStartsSV.value;
            const n = starts.length;
            if (n === 0) {
                activeIndexSV.value = -1;
                activeChunkSV.value = -1;
                return;
            }
            let idx = -1;
            if (cur.posMs >= starts[0]) {
                let lo = 0, hi = n - 1;
                while (lo < hi) {
                    const mid = (lo + hi + 1) >> 1;
                    if (starts[mid] <= cur.posMs) lo = mid;
                    else hi = mid - 1;
                }
                idx = lo;
            }
            if (activeIndexSV.value !== idx) activeIndexSV.value = idx;
            // Bounds-check: during a rebuild the parallel arrays swap one after
            // another, so idx (from the old starts) can briefly exceed the new
            // chunks array — clamp to -1 instead of leaking undefined/NaN.
            const map = wordChunksSV.value;
            const ci = idx >= 0 && idx < map.length ? map[idx] : -1;
            if (activeChunkSV.value !== ci) activeChunkSV.value = ci;
        },
    );

    // ── Auto-scroll on chunk change (forward AND backward) ───────────────────
    useAnimatedReaction(
        () => activeChunkSV.value,
        (ci, prevCi) => {
            if (prevCi === null || ci === prevCi) return;
            if (ci < 0) {
                activeTargetYSV.value = -1;
                return;
            }
            const map = chunkToDisplaySV.value;
            const offs = itemOffsetsSV.value;
            if (ci >= map.length) return;
            const di = map[ci];
            if (di < 0 || di >= offs.length) return;

            // True measured position when the cell has ever mounted; the
            // prefix-sum estimate (whose error grows over unmounted spans)
            // only as a fallback for far, never-visited regions.
            const ys = trueYSV.value;
            const hs = trueHSV.value;
            const isTrue = di < ys.length && !isNaN(ys[di]);
            let y, len;
            if (isTrue) {
                y = ys[di];
                len = isNaN(hs[di]) ? 0 : hs[di];
            } else {
                y = offs[di];
                len = di + 1 < offs.length ? offs[di + 1] - offs[di] : 0;
            }
            const target = computeTarget(y, len);
            activeTargetYSV.value = target;

            // Never move the list under the user's finger or against their will.
            if (followSV.value !== 1 || isTouchingSV.value === 1) return;

            // Big jumps fade-snap instead of animating through thousands of px
            // of unmounted cells.
            const isSeek = Math.abs(ci - prevCi) > SEEK_CHUNK_GAP
                || Math.abs(target - scrollOffsetSV.value) > viewportHSV.value * 1.5;
            if (isSeek) {
                scrollToTarget(target, true);
            } else if (Math.abs(target - lastScrollTargetSV.value) >= deadZoneSV.value) {
                scrollToTarget(target, false);
            } else {
                return;
            }
            // Estimate-based scrolls get one settle-correction once truth lands.
            pendingCorrectionSV.value = isTrue ? -1 : di;
        },
    );

    // ── Follow state + pill ───────────────────────────────────────────────────
    // 0 hidden · 1 active line above viewport center · 2 below
    const [pillState, setPillState] = useState(0);
    useAnimatedReaction(
        () => {
            if (followSV.value === 1) return 0;
            const target = activeTargetYSV.value;
            if (target < 0) return 0;
            const d = target - scrollOffsetSV.value;
            const threshold = Math.max(deadZoneSV.value * 2, viewportHSV.value * 0.12);
            if (Math.abs(d) < threshold) return 0;
            return d > 0 ? 2 : 1;
        },
        (state, prev) => {
            if (state !== prev) runOnJS(setPillState)(state);
        },
    );

    const onPillPress = useCallback(() => {
        runOnUI(() => {
            'worklet';
            followSV.value = 1;
            const target = activeTargetYSV.value;
            if (target < 0) return;
            // Start the animation from the real position, not a stale driver value.
            scrollYSV.value = scrollOffsetSV.value;
            const snap = Math.abs(target - scrollOffsetSV.value) > viewportHSV.value * 1.5;
            scrollToTarget(target, snap);
        })();
    }, [followSV, activeTargetYSV, scrollYSV, scrollOffsetSV, viewportHSV, scrollToTarget]);

    // All sub-handlers run as worklets on the UI thread — no bridge crossing.
    const scrollHandler = useAnimatedScrollHandler({
        onScroll: (e) => {
            scrollOffsetSV.value = e.contentOffset.y;
        },
        onBeginDrag: () => {
            isTouchingSV.value = 1;
            followSV.value = 0; // any drag disengages follow until the pill is tapped
            cancelAnimation(scrollYSV);
            cancelAnimation(opacitySV);
            fadeGenSV.value++;  // invalidate any in-flight fade-snap generation
            opacitySV.value = 1;
        },
        onEndDrag: (e) => {
            isTouchingSV.value = 0;
            // Sync the driver only when no momentum follows — syncing during a
            // fling would scrollTo() back and kill it. Momentum flings sync below.
            const vy = e.velocity ? e.velocity.y : 0;
            if (Math.abs(vy) < 0.05) scrollYSV.value = e.contentOffset.y;
        },
        onMomentumEnd: (e) => {
            if (isTouchingSV.value === 0) scrollYSV.value = e.contentOffset.y;
        },
    });

    const listAnimStyle = useAnimatedStyle(() => ({ opacity: opacitySV.value }));

    // ── Seeks (chunk tap, keypoint tap, word replay, external) ───────────────
    // seekTo preserves the play/pause state natively: while paused this only
    // moves the position + highlight, it never force-plays.
    const doSeek = useCallback((ms) => {
        followSV.value = 1;
        TrackPlayer.seekTo(Math.max(0, ms) / 1000);
    }, [followSV]);

    const onChunkPress = useCallback((startMs) => doSeek(startMs), [doSeek]);
    const onKeypointPress = useCallback((timeMs) => doSeek(timeMs), [doSeek]);

    // Keep chunks accessible inside handlers without making them deps.
    const chunksRef = useRef(EMPTY_COMPUTED.chunks);
    useEffect(() => { chunksRef.current = computed.chunks; }, [computed]);

    // ── Translation modal (paragraph long-press) ─────────────────────────────
    const [translateModal, setTranslateModal] = useState({ visible: false, text: '', contextText: '' });
    const onLongPress = useCallback((text, chunkIndex) => {
        const ch = chunksRef.current;
        const prevTexts = [];
        if (chunkIndex >= 2 && ch[chunkIndex - 2]) prevTexts.push(ch[chunkIndex - 2].words.map(w => w.text).join('').trim());
        if (chunkIndex >= 1 && ch[chunkIndex - 1]) prevTexts.push(ch[chunkIndex - 1].words.map(w => w.text).join('').trim());
        const contextText = [...prevTexts, text].join('\n\n');
        setTranslateModal({ visible: true, text, contextText });
    }, []);
    const closeModal = useCallback(() => setTranslateModal({ visible: false, text: '', contextText: '' }), []);

    // ── Word popover (word tap in word-level chunks) ─────────────────────────
    const [wordPopover, setWordPopover] = useState(null);
    const onWordPress = useCallback((word, chunkIndex) => {
        const ch = chunksRef.current[chunkIndex];
        // Unicode-aware edge-trim so accented loanwords ('café', 'résumé') keep
        // their letters instead of being clipped to 'caf' / 'r' before lookup.
        const cleaned = (word.text || '').trim().replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');
        if (!cleaned) return;
        setWordPopover({
            word: cleaned,
            startMs: Math.round(word.startMs),
            contextText: ch ? ch.words.map(w => w.text).join('').trim() : '',
        });
    }, []);
    const closeWordPopover = useCallback(() => setWordPopover(null), []);
    const onWordReplay = useCallback((ms) => {
        setWordPopover(null);
        doSeek(ms);
    }, [doSeek]);

    // ── Imperative API (PlayerScreen) ─────────────────────────────────────────
    const replayAnchorRef = useRef({ t: 0, chunk: -1 });
    useImperativeHandle(ref, () => ({
        // Replay current chunk start; a second press within 3s steps to the
        // previous chunk (and keeps stepping back on further presses).
        replaySentence: () => {
            const chs = chunksRef.current;
            if (!chs.length) return;
            const now = Date.now();
            let target = activeChunkSV.value;
            if (now - replayAnchorRef.current.t < 3000) {
                target = Math.max(0, replayAnchorRef.current.chunk - 1);
            }
            target = Math.min(Math.max(target, 0), chs.length - 1);
            replayAnchorRef.current = { t: now, chunk: target };
            doSeek(chs[target].startMs);
        },
        seekToMs: (ms) => doSeek(ms),
    }), [doSeek, activeChunkSV]);

    // ── Render ────────────────────────────────────────────────────────────────

    const renderItem = useCallback(({ item, index }) => {
        if (item.type === 'keypoint') {
            return <KeypointRow item={item} onPress={onKeypointPress} />;
        }
        return (
            <Chunk
                item={item}
                index={index}
                fontSize={fontSize}
                lineHeight={lineHeight}
                activeChunkSV={activeChunkSV}
                activeIndexSV={activeIndexSV}
                isPlayingSV={isPlayingSV}
                onPress={onChunkPress}
                onLongPress={onLongPress}
                onWordPress={onWordPress}
                onCellLayout={onCellLayout}
            />
        );
    }, [
        fontSize, lineHeight, activeChunkSV, activeIndexSV, isPlayingSV,
        onChunkPress, onLongPress, onWordPress, onCellLayout, onKeypointPress,
    ]);

    let statusPane = null;
    if (displayItems.length === 0) {
        if (loading) {
            statusPane = (
                <View style={styles.empty}>
                    <ActivityIndicator size='small' color={colors.accent} />
                    <Text style={[styles.placeholder, styles.placeholderGap]}>Loading transcript…</Text>
                </View>
            );
        } else if (isBuilding && segments?.length) {
            statusPane = (
                <View style={styles.empty}>
                    <ActivityIndicator size='small' color={colors.accent} />
                    <Text style={[styles.placeholder, styles.placeholderGap]}>Preparing transcript…</Text>
                </View>
            );
        } else if (isQueued) {
            statusPane = (
                <View style={styles.empty}>
                    <ActivityIndicator size='small' color={colors.accent} />
                    <Text style={[styles.placeholder, styles.placeholderGap]}>
                        Queued for transcription
                    </Text>
                </View>
            );
        } else if (transcribing) {
            statusPane = (
                <View style={styles.empty}>
                    <ActivityIndicator size='small' color={colors.accent} />
                    <Text style={[styles.placeholder, styles.placeholderGap]}>
                        Transcribing… {clampPercent(transcribeProgress)}%
                    </Text>
                </View>
            );
        } else if (!hasTranscript) {
            statusPane = (
                <View style={styles.empty}>
                    <View style={styles.ctaCard}>
                        <Icon name='file-text' size={26} color={colors.textMuted} />
                        <Text style={styles.ctaTitle}>No transcript yet</Text>
                        {canTranscribe ? (
                            <>
                                <Text style={styles.ctaBody}>
                                    Generate a transcript on-device to read along while you listen.
                                </Text>
                                <Pressable
                                    onPress={onTranscribe}
                                    android_ripple={CHUNK_RIPPLE}
                                    style={({ pressed }) => [styles.ctaBtn, pressed && styles.pressedChunk]}
                                >
                                    <Icon name='type' size={15} color={colors.bg} />
                                    <Text style={styles.ctaBtnText}>Transcribe episode</Text>
                                </Pressable>
                            </>
                        ) : (
                            <Text style={styles.ctaBody}>Download this episode first to transcribe it.</Text>
                        )}
                    </View>
                </View>
            );
        } else {
            statusPane = (
                <View style={styles.empty}>
                    <Text style={styles.placeholder}>No transcript available</Text>
                </View>
            );
        }
    }

    return (
        <View style={styles.root} onLayout={onViewportLayout}>
            {isFocused && (
                <PositionFeeder positionMsSV={positionMsSV} isPlayingSV={isPlayingSV} />
            )}

            <TranslationModal
                visible={translateModal.visible}
                text={translateModal.text}
                contextText={translateModal.contextText}
                lang={translationLang}
                onClose={closeModal}
            />
            <WordPopover
                data={wordPopover}
                lang={translationLang}
                episodeId={episodeId}
                episodeTitle={episodeTitle}
                onClose={closeWordPopover}
                onReplay={onWordReplay}
            />

            {statusPane ?? (
                <>
                    <AnimatedFlatList
                        ref={flatListRef}
                        data={displayItems}
                        keyExtractor={keyExtractor}
                        renderItem={renderItem}
                        getItemLayout={getItemLayout}
                        CellRendererComponent={CellRenderer}
                        style={[styles.container, listAnimStyle]}
                        contentContainerStyle={styles.contentContainer}
                        showsVerticalScrollIndicator={false}
                        scrollEventThrottle={16}
                        onScroll={scrollHandler}
                        onContentSizeChange={onContentSizeChange}
                        initialNumToRender={12}
                        maxToRenderPerBatch={5}
                        windowSize={5}
                        updateCellsBatchingPeriod={50}
                        removeClippedSubviews={Platform.OS === 'android'}
                        ListHeaderComponent={LIST_HEADER}
                        ListFooterComponent={listFooter}
                    />

                    {/* Native gradient scrims — drawn over the list, untouchable */}
                    <FadeEdge height={VIGNETTE_TOP_H} position='top' color={fadeTo} />
                    <FadeEdge height={VIGNETTE_BOT_H} position='bottom' color={fadeTo} />

                    {transcribing && (
                        <View style={styles.progressBadgeWrap} pointerEvents='none'>
                            <View style={styles.progressBadge}>
                                <ActivityIndicator size='small' color={colors.accent} />
                                <Text style={styles.progressBadgeText}>
                                    Transcribing… {clampPercent(transcribeProgress)}%
                                </Text>
                            </View>
                        </View>
                    )}

                    {pillState !== 0 && (
                        <FollowPill
                            direction={pillState === 2 ? 'down' : 'up'}
                            onPress={onPillPress}
                        />
                    )}
                </>
            )}
        </View>
    );
});

// ─── FadeEdge ─────────────────────────────────────────────────────────────────
// RN 0.83 native linear gradient (new-arch). Transparent stop uses the bg's own
// RGB so the fade never passes through gray. `color` must be a #RRGGBB hex.

const FadeEdge = ({ height, position, color }) => (
    <View
        pointerEvents='none'
        style={[
            styles.fadeEdge,
            position === 'top' ? { top: 0, height } : { bottom: 0, height },
            {
                experimental_backgroundImage: `linear-gradient(${position === 'top' ? 'to bottom' : 'to top'}, ${withAlpha(color, 1)}, ${withAlpha(color, 0)})`,
            },
        ]}
    />
);

// ─── Keypoint ─────────────────────────────────────────────────────────────────

const KeypointRow = React.memo(({ item, onPress }) => (
    <Pressable
        onPress={() => onPress(item.timeMs)}
        android_ripple={CHUNK_RIPPLE}
        style={({ pressed }) => [styles.keypointRow, pressed && styles.pressedChunk]}
    >
        <View style={styles.keypointLine} />
        <Text style={styles.keypointLabel}>{item.label}</Text>
        <View style={styles.keypointLine} />
    </Pressable>
));

// ─── Chunk ────────────────────────────────────────────────────────────────────
//
// Manages its own isWordLevel / isPast state via useAnimatedReaction — when
// activeChunkSV changes, only the 2-3 boundary chunks call runOnJS, everything
// else skips on the UI thread. FlatList never drives re-renders here.

const chunkEqual = (p, n) =>
    p.item === n.item && p.index === n.index &&
    p.fontSize === n.fontSize && p.lineHeight === n.lineHeight &&
    p.onPress === n.onPress && p.onLongPress === n.onLongPress &&
    p.onWordPress === n.onWordPress && p.onCellLayout === n.onCellLayout;

const Chunk = React.memo(({
    item, index, fontSize, lineHeight,
    activeChunkSV, activeIndexSV, isPlayingSV,
    onPress, onLongPress, onWordPress, onCellLayout,
}) => {
    const chunkIndex = item.chunkIndex;
    const text = useMemo(() => item.words.map(w => w.text).join('').trim(), [item]);

    const [isWordLevel, setIsWordLevel] = useState(false);
    const [isPast, setIsPast] = useState(false);

    useAnimatedReaction(
        () => ({
            wl: Math.abs(chunkIndex - activeChunkSV.value) <= WORD_LEVEL_RADIUS,
            past: chunkIndex < activeChunkSV.value,
        }),
        (next, prev) => {
            if (!prev || next.wl !== prev.wl) runOnJS(setIsWordLevel)(next.wl);
            if (!prev || next.past !== prev.past) runOnJS(setIsPast)(next.past);
        },
    );

    const handleLayout = useCallback((e) => {
        onCellLayout(index, item.id, e.nativeEvent.layout.height);
    }, [onCellLayout, index, item.id]);

    const handlePress = useCallback(() => onPress(item.startMs), [onPress, item.startMs]);
    const handleLongPress = useCallback(() => onLongPress(text, chunkIndex), [onLongPress, text, chunkIndex]);

    const baseStyle = {
        fontSize,
        lineHeight,
        fontWeight: '500',
        color: isPast ? colors.transcriptSpoken : colors.transcriptFuture,
    };

    if (isWordLevel) {
        // Word-by-word reading region (active ± 1): tapping a word must open the
        // dictionary popover. The parent Text has NO press handlers at all — a
        // parent Text that owns onPress OR onLongPress claims the touch responder
        // for the whole block, starving the per-word handlers (word taps did
        // nothing / the parent seeked). So every handler lives on the words:
        // tap = define, long-press = translate the sentence. Seeking stays on
        // the other (non-word-level) sentences and the transport controls.
        return (
            <View style={styles.sentenceWrap} onLayout={handleLayout}>
                <Text
                    style={baseStyle}
                    suppressHighlighting
                >
                    {item.words.map(w => (
                        <Word
                            key={w.globalIndex}
                            word={w}
                            chunkIndex={chunkIndex}
                            fontSize={fontSize}
                            lineHeight={lineHeight}
                            activeIndexSV={activeIndexSV}
                            isPlayingSV={isPlayingSV}
                            onWordPress={onWordPress}
                            onWordLongPress={handleLongPress}
                        />
                    ))}
                </Text>
            </View>
        );
    }

    return (
        <Pressable
            onLayout={handleLayout}
            onPress={handlePress}
            onLongPress={handleLongPress}
            delayLongPress={400}
            android_ripple={CHUNK_RIPPLE}
            style={({ pressed }) => [styles.sentenceWrap, pressed && styles.pressedChunk]}
        >
            <Text style={baseStyle}>{text}</Text>
        </Pressable>
    );
}, chunkEqual);

// ─── Word ─────────────────────────────────────────────────────────────────────
// Only mounted inside word-level chunks (active ± 1), so the per-word press
// handlers stay bounded to ~100 instances.

const Word = React.memo(({
    word, chunkIndex, fontSize, lineHeight,
    activeIndexSV, isPlayingSV, onWordPress, onWordLongPress,
}) => {
    const colorState = useSharedValue(0); // 0 future · 1 spoken · 2 active

    useAnimatedReaction(
        () => {
            const ai = activeIndexSV.value;
            const playing = isPlayingSV.value === 1;
            if (word.globalIndex === ai && playing) return 2;
            if (word.globalIndex <= ai) return 1;
            return 0;
        },
        (next, prev) => {
            if (next === prev) return;
            if (prev === null) { colorState.value = next; return; }
            if (next === 2) colorState.value = withTiming(2, { duration: 80 });
            else if (next === 1 && prev === 2) colorState.value = withTiming(1, { duration: 150, easing: Easing.out(Easing.quad) });
            else colorState.value = withTiming(next, { duration: 100 });
        },
    );

    const animStyle = useAnimatedStyle(() => ({
        color: interpolateColor(colorState.value, [0, 1, 2], [colors.transcriptFuture, colors.transcriptSpoken, colors.transcriptActive]),
        textShadowColor: interpolateColor(colorState.value, [1, 2], ['transparent', colors.transcriptGlow]),
        textShadowOffset: { width: 0, height: 0 },
        textShadowRadius: interpolate(colorState.value, [1, 2], [0, 14], 'clamp'),
    }));

    const handlePress = useCallback(() => onWordPress(word, chunkIndex), [onWordPress, word, chunkIndex]);

    // Press lives on a PLAIN Text — onPress on a nested Animated.Text does not
    // fire inside a parent Text (RN press hit-testing only routes to real Text
    // spans), so the animated colour goes on an inner Animated.Text while the
    // outer Text owns the tap-to-define / long-press-to-translate handlers.
    return (
        <Text
            selectable={false}
            suppressHighlighting
            onPress={handlePress}
            onLongPress={onWordLongPress}
        >
            <Animated.Text style={[{ fontSize, lineHeight, fontWeight: '500' }, animStyle]}>
                {word.text}
            </Animated.Text>
        </Text>
    );
});

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: 'transparent' },
    container: { flex: 1, backgroundColor: 'transparent' },
    contentContainer: { paddingHorizontal: 24 },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 },
    placeholder: { fontSize: 16, color: colors.textSecondary, textAlign: 'center' },
    placeholderGap: { marginTop: 12 },

    sentenceWrap: { marginBottom: CHUNK_MARGIN },
    pressedChunk: { opacity: 0.65 },

    keypointRow: {
        flexDirection: 'row',
        alignItems: 'center',
        height: KEYPOINT_HEIGHT,
        marginBottom: CHUNK_MARGIN,
    },
    keypointLine: { flex: 1, height: 0.5, backgroundColor: colors.hairline },
    keypointLabel: { color: colors.transcriptSpoken, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, paddingHorizontal: 10 },

    fadeEdge: { position: 'absolute', left: 0, right: 0 },

    progressBadgeWrap: { position: 'absolute', top: 12, left: 0, right: 0, alignItems: 'center' },
    progressBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: withAlpha(colors.bgPlayer, 0.92),
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: radii.pill,
        borderWidth: 0.5,
        borderColor: colors.hairline,
    },
    progressBadgeText: { fontSize: 12, color: colors.textSecondary, fontWeight: '600' },

    ctaCard: {
        alignItems: 'center',
        gap: 10,
        backgroundColor: colors.surface,
        borderRadius: radii.l,
        borderWidth: 0.5,
        borderColor: colors.hairline,
        paddingVertical: 28,
        paddingHorizontal: 24,
        width: '100%',
    },
    ctaTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary, letterSpacing: -0.3 },
    ctaBody: { fontSize: 13, lineHeight: 19, color: colors.textSecondary, textAlign: 'center' },
    ctaBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: colors.accent,
        paddingHorizontal: 20,
        paddingVertical: 11,
        borderRadius: radii.pill,
        marginTop: 6,
    },
    ctaBtnText: { fontSize: 14, fontWeight: '700', color: colors.bg },
});

export default TranscriptHighlighter;
