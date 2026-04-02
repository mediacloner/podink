import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
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
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import TrackPlayer, { useProgress, usePlaybackState, State } from "react-native-track-player";
import { useSafeAreaInsets } from "react-native-safe-area-context";

// ─── Constants ───────────────────────────────────────────────────────────────

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get("window");
const CONTENT_WIDTH   = SCREEN_WIDTH - 48;    // paddingHorizontal: 24 * 2
const CENTER_OFFSET   = SCREEN_HEIGHT * 0.28; // active chunk sits near vertical center of the transcript area
const CHUNK_MARGIN    = 10;                   // matches sentenceWrap.marginBottom
const FONT_SIZE       = 22;
const LINE_HEIGHT     = 28;
const CHAR_WIDTH      = FONT_SIZE * 0.52;     // empirical ratio for weight 500
const LOOKAHEAD_MS    = 550;
const WORD_LEVEL_RADIUS      = 1;             // prev + current + next chunk → word-by-word
const KEYPOINT_INTERVAL_MS   = 10 * 60 * 1000;
const KEYPOINT_HEIGHT        = 36;            // fixed — used in both layout and scroll math

// Dark theme (light text on dark bg) — kept for potential future use
const DARK_FUTURE = "#3A3530"; // dark warm brown-gray — amber undertone, not cold
const DARK_SPOKEN = "#A09078"; // warm taupe — sandy, like aged paper in low light
const DARK_ACTIVE = "#FFF6E8"; // candlelight cream — warm white, easy on the eyes
// Light theme (dark text on light bg) — Apple Podcasts system palette
const LIGHT_FUTURE = "#D1D1D6"; // iOS gray 5 — barely-there future text
const LIGHT_SPOKEN = "#8E8E93"; // iOS gray 2 — already-spoken text
const LIGHT_ACTIVE = "#1C1C1E"; // iOS label    — current active word

// Kept for backwards compat with default value
const COLOR_FUTURE = DARK_FUTURE;
const COLOR_SPOKEN = DARK_SPOKEN;
const COLOR_ACTIVE = DARK_ACTIVE;

const BG = "#0E0C13";             // very dark indigo — richer than pure black
const VIGNETTE_STEPS = 10;
const VIGNETTE_TOP_H = 110;
const VIGNETTE_BOT_H = 130;

const HEADER_HEIGHT = SCREEN_HEIGHT * 0.10;
const LIST_HEADER = <View style={{ height: HEADER_HEIGHT }} />;
const LIST_FOOTER = <View style={{ height: SCREEN_HEIGHT * 0.5 }} />;

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function formatTime(ms) {
  const s  = Math.floor(ms / 1000);
  const h  = Math.floor(s / 3600);
  const m  = Math.floor((s % 3600) / 60);
  const sc = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sc).padStart(2, "0")}`
    : `${m}:${String(sc).padStart(2, "0")}`;
}

// O(log n) binary search — last word whose startMs ≤ posMs.
function findActiveIndex(timings, posMs) {
  if (!timings.length || posMs < timings[0].startMs) return -1;
  let lo = 0, hi = timings.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    timings[mid].startMs <= posMs ? (lo = mid) : (hi = mid - 1);
  }
  return timings[lo].startMs <= posMs ? lo : -1;
}

// Estimate the rendered height of a chunk from its word list.
// Feeds getItemLayout so FlatList never renders an item just to know its size.
function estimateChunkHeight(words) {
  const chars = words.reduce((n, w) => n + w.text.length, 0);
  const lines = Math.max(1, Math.ceil((chars * CHAR_WIDTH) / CONTENT_WIDTH));
  return lines * LINE_HEIGHT;
}

// ─── Component ────────────────────────────────────────────────────────────────

const TranscriptHighlighter = ({ segments, fadeTo = BG, textTheme = 'dark' }) => {
  const cFuture = textTheme === 'light' ? LIGHT_FUTURE : DARK_FUTURE;
  const cSpoken = textTheme === 'light' ? LIGHT_SPOKEN : DARK_SPOKEN;
  const cActive = textTheme === 'light' ? LIGHT_ACTIVE : DARK_ACTIVE;
  const glowColor = textTheme === 'light' ? 'transparent' : 'rgba(79,172,254,0.75)';
  const { position }  = useProgress(100);
  const playbackState = usePlaybackState();

  // useAnimatedRef() instead of useRef() — required for Reanimated's scrollTo worklet.
  const flatListRef  = useAnimatedRef();


  // ── SharedValues (zero React re-renders for word highlighting) ───────────
  const activeIndexSV = useSharedValue(-1);
  const isPlayingSV   = useSharedValue(1);  // 1 = playing, 0 = paused
  // activeChunkSV replaces both activeChunkIndex state and activeChunkRef.
  // Each Chunk subscribes to this via useAnimatedReaction — only the 2-3 cells
  // near the boundary call runOnJS(setter) to update their own state. FlatList
  // never gets extraData re-renders.
  const activeChunkSV = useSharedValue(-1);
  const opacitySV     = useSharedValue(1);   // drives fade-out/in on seek

  useEffect(() => {
    isPlayingSV.value = playbackState.state === State.Playing ? 1 : 0;
  }, [playbackState.state, isPlayingSV]);

  const prevChunkRef       = useRef(-1); // detects seek vs normal advance
  const lastScrollTargetRef = useRef(0);  // last position we actually scrolled to

  // How far the active chunk must drift from the last scroll position before
  // we trigger a new scroll. Prevents jitter on short/frequent paragraphs.
  const SCROLL_DEAD_ZONE = LINE_HEIGHT * 1.5; // ≈ 42 px — about one short line

  // Manual scroll detection — suppresses auto-follow while user reads ahead.
  const isUserScrollingRef   = useRef(false);
  const userScrollTimeoutRef = useRef(null);

  // ── Smooth scroll ─────────────────────────────────────────────────────────
  // scrollYSV is the single source of truth. Auto-scroll animates it with
  // withTiming (custom easing) and useAnimatedReaction drives scrollTo on
  // every frame — no bridge crossing, no platform-default animation.
  // currentScrollYRef tracks where the user left the list so the animation
  // always starts from the real position rather than a stale SharedValue.
  const scrollYSV        = useSharedValue(0);
  const currentScrollYRef = useRef(0);

  useAnimatedReaction(
    () => scrollYSV.value,
    (y, prev) => {
      // prev is null on the very first call, before the FlatList ref is
      // attached — skip it to avoid the "uninitialized ref" Reanimated error.
      if (prev === null) return;
      scrollTo(flatListRef, 0, y, false);
    },
  );

  // ── Build chunk data ──────────────────────────────────────────────────────

  const chunks = useMemo(() => {
    if (!segments?.length) return [];
    const result = [];
    let cur = [], startMs = 0, gi = 0;
    segments.forEach((seg, si) => {
      const raw  = seg.text.trim();
      if (!raw) return;
      const sMs  = seg.start_time ?? seg.start ?? 0;
      const eMs  = seg.end_time   ?? seg.end   ?? sMs + 2000;
      const ws   = raw.split(/\s+/).filter(Boolean);
      const tpw  = (eMs - sMs) / Math.max(1, ws.length);

      ws.forEach((w, wi) => {
        if (!cur.length) startMs = sMs + wi * tpw;
        cur.push({ text: w + " ", startMs: sMs + wi * tpw, globalIndex: gi++ });

        const last = wi === ws.length - 1;
        const sent = w.endsWith(".") || w.endsWith("?") || w.endsWith("!");
        if (sent || cur.length >= 35 || (si === segments.length - 1 && last)) {
          result.push({ id: `c${result.length}`, words: cur, startMs, chunkIndex: result.length });
          cur = [];
        }
      });
    });
    return result;
  }, [segments]);

  // Interleave chunks with 10-minute keypoint markers.
  const displayItems = useMemo(() => {
    const items = [];
    let nextKp = KEYPOINT_INTERVAL_MS;
    chunks.forEach(chunk => {
      while (chunk.startMs >= nextKp) {
        items.push({ type: "keypoint", id: `kp${nextKp}`, timeMs: nextKp, label: formatTime(nextKp) });
        nextKp += KEYPOINT_INTERVAL_MS;
      }
      items.push({ type: "chunk", ...chunk });
    });
    return items;
  }, [chunks]);

  // Pre-compute estimated item lengths and their cumulative offsets (including header).
  // itemOffsets[i] = distance from top of scroll content to item i.
  // getItemLayout returns these — FlatList can then virtualize any position without renders.
  const { itemLengths, itemOffsets } = useMemo(() => {
    const lengths = new Array(displayItems.length);
    const offsets = new Array(displayItems.length);
    let y = HEADER_HEIGHT; // first item sits after the LIST_HEADER
    displayItems.forEach((item, i) => {
      offsets[i] = y;
      const len = item.type === "keypoint"
        ? KEYPOINT_HEIGHT + CHUNK_MARGIN
        : estimateChunkHeight(item.words) + CHUNK_MARGIN;
      lengths[i] = len;
      y += len;
    });
    return { itemLengths: lengths, itemOffsets: offsets };
  }, [displayItems]);

  // chunkIndex → position inside displayItems (accounts for keypoints before it).
  const chunkDisplayIndex = useMemo(() => {
    const map = {};
    displayItems.forEach((item, i) => { if (item.type === "chunk") map[item.chunkIndex] = i; });
    return map;
  }, [displayItems]);

  const wordTimings = useMemo(() => {
    const arr = [];
    chunks.forEach(ch => ch.words.forEach(w => {
      arr[w.globalIndex] = { startMs: w.startMs, chunkIndex: ch.chunkIndex };
    }));
    return arr;
  }, [chunks]);

  // ── UI-thread scroll via Reanimated ──────────────────────────────────────

  // Normal advance: animate scrollYSV to target from wherever it currently is.
  // scrollYSV is kept in sync with the real position after every user gesture
  // (see onScrollEndDrag / onMomentumScrollEnd), so no snap-reset is needed here.
  const triggerScroll = useCallback((y) => {
    runOnUI((targetY) => {
      "worklet";
      scrollYSV.value = withTiming(targetY, {
        duration: 900,
        easing:   Easing.out(Easing.cubic),
      });
    })(y);
  }, [scrollYSV]);

  // Seek (large jump): fade out → instant position reset → fade in.
  const triggerSeekScroll = useCallback((y) => {
    runOnUI((targetY) => {
      "worklet";
      opacitySV.value = withTiming(0, { duration: 120 }, (finished) => {
        "worklet";
        if (finished) {
          scrollYSV.value = targetY;
          opacitySV.value = withTiming(1, { duration: 200, easing: Easing.out(Easing.quad) });
        }
      });
    })(y);
  }, [scrollYSV, opacitySV]);

  const listAnimStyle = useAnimatedStyle(() => ({ opacity: opacitySV.value }));

  // ── Playback tick (100ms) ─────────────────────────────────────────────────
  //
  // Single effect handles word highlighting, chunk self-updates, and scrolling.
  // activeChunkSV drives per-Chunk useAnimatedReaction — only 2-3 boundary cells
  // ever call runOnJS. FlatList extraData is not needed.
  useEffect(() => {
    const posMs = position * 1000 + LOOKAHEAD_MS;
    const idx   = findActiveIndex(wordTimings, posMs);
    activeIndexSV.value = idx;

    const ci = idx >= 0 ? (wordTimings[idx]?.chunkIndex ?? 0) : -1;
    activeChunkSV.value = ci;

    if (ci !== prevChunkRef.current) {
      const prevCi = prevChunkRef.current;
      prevChunkRef.current = ci;

      const di = chunkDisplayIndex[ci];
      if (di !== undefined) {
        // itemOffsets[di] is the content-absolute offset (including LIST_HEADER).
        // Subtracting CENTER_OFFSET positions the item at 35% from screen top —
        // identical to what getItemLayout reports, so scroll always matches rendering.
        const scrollY = Math.max(0, (itemOffsets[di] ?? CENTER_OFFSET) - CENTER_OFFSET);
        const isSeek  = Math.abs(ci - prevCi) > 3;
        if (isSeek) {
          // Explicit jump — snap immediately, reset the dead-zone anchor.
          lastScrollTargetRef.current = scrollY;
          triggerSeekScroll(scrollY);
        } else if (
          !isUserScrollingRef.current &&
          scrollY >= currentScrollYRef.current &&
          scrollY - lastScrollTargetRef.current >= SCROLL_DEAD_ZONE
        ) {
          // Only scroll forward, and only when the active chunk has drifted
          // far enough from the last scroll position. Short back-to-back
          // paragraphs accumulate silently until they exceed the dead zone.
          lastScrollTargetRef.current = scrollY;
          triggerScroll(scrollY);
        }
      }
    }
  }, [position, wordTimings, activeIndexSV, activeChunkSV, chunkDisplayIndex, itemOffsets, triggerScroll, triggerSeekScroll]);

  // ── getItemLayout ─────────────────────────────────────────────────────────
  //
  // Without this, FlatList renders every intermediate item when jumping position.
  // With it, FlatList instantly knows the size and offset of any item.
  // The estimates come from text content (character count × char width → line count).
  // Even if slightly off, they're consistently wrong in the same direction —
  // measured heights correct themselves as chunks scroll into view.
  const getItemLayout = useCallback((_, index) => ({
    length: itemLengths[index] ?? 65,
    offset: itemOffsets[index] ?? (CENTER_OFFSET + index * 65),
    index,
  }), [itemLengths, itemOffsets]);

  // ── User scroll detection ─────────────────────────────────────────────────

  const onScrollBeginDrag = useCallback(() => {
    isUserScrollingRef.current = true;
    clearTimeout(userScrollTimeoutRef.current);
    // Stop any in-flight auto-scroll animation so it doesn't fight the finger.
    runOnUI(() => { "worklet"; cancelAnimation(scrollYSV); })();
  }, [scrollYSV]);

  // After user scroll ends, sync scrollYSV to the real position so the next
  // auto-scroll animation starts exactly where the list is — no snap, no jump.
  const resumeAutoScroll = useCallback((e, delay) => {
    const y = e.nativeEvent.contentOffset.y;
    currentScrollYRef.current = y;
    runOnUI((pos) => { "worklet"; scrollYSV.value = pos; })(y);
    clearTimeout(userScrollTimeoutRef.current);
    userScrollTimeoutRef.current = setTimeout(() => {
      isUserScrollingRef.current = false;
    }, delay);
  }, [scrollYSV]);

  // Resume 3s after finger lifts; 1s after momentum ends (inertia finished).
  const onScrollEndDrag     = useCallback((e) => resumeAutoScroll(e, 3000), [resumeAutoScroll]);
  const onMomentumScrollEnd = useCallback((e) => resumeAutoScroll(e, 1000), [resumeAutoScroll]);

  // Track real scroll position so triggerScroll always starts from here.
  const onScroll = useCallback((e) => {
    currentScrollYRef.current = e.nativeEvent.contentOffset.y;
  }, []);

  // ── Translation modal ─────────────────────────────────────────────────────

  const [translateModal, setTranslateModal] = useState({ visible: false, text: "", contextText: "" });
  // Tap to seek — jump playback to that chunk's start time.
  const onChunkPress = useCallback((startMs) => {
    TrackPlayer.seekTo(startMs / 1000);
    TrackPlayer.play();
  }, []);

  // Keep chunks accessible inside onLongPress without making it a dep.
  // This keeps onLongPress reference stable so renderItem never changes.
  const chunksRef = useRef(chunks);
  useEffect(() => { chunksRef.current = chunks; }, [chunks]);
  const onLongPress = useCallback((text, chunkIndex) => {
    const ch = chunksRef.current;
    const prevTexts = [];
    if (chunkIndex >= 2) prevTexts.push(ch[chunkIndex - 2].words.map(w => w.text).join("").trim());
    if (chunkIndex >= 1) prevTexts.push(ch[chunkIndex - 1].words.map(w => w.text).join("").trim());
    const contextText = [...prevTexts, text].join("\n\n");
    setTranslateModal({ visible: true, text, contextText });
  }, []);
  const closeModal  = useCallback(() => setTranslateModal({ visible: false, text: "", contextText: "" }), []);

  // ── Render ────────────────────────────────────────────────────────────────

  // Fully stable — all deps are SharedValues or stable callbacks.
  // FlatList never needs to re-render cells due to parent state changes.
  const renderItem = useCallback(({ item }) => {
    if (item.type === "keypoint") return <Keypoint item={item} />;
    return (
      <Chunk
        item={item}
        activeChunkSV={activeChunkSV}
        activeIndexSV={activeIndexSV}
        isPlayingSV={isPlayingSV}
        onLongPress={onLongPress}
        onPress={onChunkPress}
        cFuture={cFuture}
        cSpoken={cSpoken}
        cActive={cActive}
        glowColor={glowColor}
      />
    );
  }, [activeChunkSV, activeIndexSV, isPlayingSV, onLongPress, onChunkPress, cFuture, cSpoken, cActive, glowColor]);

  if (!segments?.length) {
    return (
      <View style={styles.empty}>
        <Text style={styles.placeholder}>No Transcript Available</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <TranslationModal visible={translateModal.visible} text={translateModal.text} contextText={translateModal.contextText} onClose={closeModal} />

      <Animated.FlatList
        ref={flatListRef}
        data={displayItems}
        keyExtractor={item => item.id}
        renderItem={renderItem}
        getItemLayout={getItemLayout}
        style={[styles.container, listAnimStyle]}
        contentContainerStyle={styles.contentContainer}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        initialNumToRender={12}
        maxToRenderPerBatch={5}
        windowSize={5}
        updateCellsBatchingPeriod={50}
        removeClippedSubviews={Platform.OS === "android"}
        ListHeaderComponent={LIST_HEADER}
        ListFooterComponent={LIST_FOOTER}
        onScroll={onScroll}
        onScrollBeginDrag={onScrollBeginDrag}
        onScrollEndDrag={onScrollEndDrag}
        onMomentumScrollEnd={onMomentumScrollEnd}
        onScrollToIndexFailed={() => {}}
      />

      {/* Vignette fades — drawn OVER the list, pointerEvents="none" so scrolling still works */}
      <FadeEdge height={VIGNETTE_TOP_H} position="top"    color={fadeTo} />
      <FadeEdge height={VIGNETTE_BOT_H} position="bottom" color={fadeTo} />
    </View>
  );
};

// ─── FadeEdge ─────────────────────────────────────────────────────────────────
// Simulates a linear gradient from BG → transparent using stacked Views.
// No external library needed.

const FadeEdge = ({ height, position, color = BG }) => {
  const bands = Array.from({ length: VIGNETTE_STEPS }, (_, i) => {
    const t = i / (VIGNETTE_STEPS - 1);
    return position === "top" ? 1 - t : t;
  });
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: 0, right: 0,
        height,
        ...(position === "top" ? { top: 0 } : { bottom: 0 }),
        flexDirection: "column",
      }}
    >
      {bands.map((opacity, i) => (
        <View key={i} style={{ flex: 1, backgroundColor: color, opacity }} />
      ))}
    </View>
  );
};

// ─── Keypoint ─────────────────────────────────────────────────────────────────

const Keypoint = React.memo(({ item }) => (
  <View style={styles.keypointRow}>
    <View style={styles.keypointLine} />
    <Text style={styles.keypointLabel}>{item.label}</Text>
    <View style={styles.keypointLine} />
  </View>
));

// ─── Chunk ────────────────────────────────────────────────────────────────────
//
// Manages its own isWordLevel / isPast state via useAnimatedReaction.
// When activeChunkSV changes, only the 2-3 boundary chunks call runOnJS —
// all other mounted chunks skip instantly. FlatList never drives re-renders here.

const chunkEqual = (p, n) =>
  p.item === n.item &&
  p.onPress === n.onPress &&
  p.cFuture === n.cFuture && p.cSpoken === n.cSpoken &&
  p.cActive === n.cActive && p.glowColor === n.glowColor;

const Chunk = React.memo(
  ({ item, activeChunkSV, activeIndexSV, isPlayingSV, onLongPress, onPress, cFuture, cSpoken, cActive, glowColor }) => {
    const chunkIndex = item.chunkIndex;
    const text = item.words.map(w => w.text).join("").trim();

    const [isWordLevel, setIsWordLevel] = useState(false);
    const [isPast,      setIsPast]      = useState(false);

    useAnimatedReaction(
      () => ({
        wl:   Math.abs(chunkIndex - activeChunkSV.value) <= WORD_LEVEL_RADIUS,
        past: chunkIndex < activeChunkSV.value,
      }),
      (next, prev) => {
        "worklet";
        if (!prev || next.wl !== prev.wl)     runOnJS(setIsWordLevel)(next.wl);
        if (!prev || next.past !== prev.past)  runOnJS(setIsPast)(next.past);
      },
    );

    return (
      <Pressable
        onPress={() => onPress(item.startMs)}
        onLongPress={() => onLongPress(text, chunkIndex)}
        delayLongPress={400}
        style={styles.sentenceWrap}
      >
        {/* Single <Text> wrapper for both modes so native text layout
            handles line-breaking consistently — eliminates the word-jump
            caused by switching between flexbox-wrap and text layout. */}
        <Text style={[styles.wordText, { color: isPast ? cSpoken : cFuture }]}>
          {isWordLevel
            ? item.words.map(w => (
                <Word
                  key={w.globalIndex}
                  word={w}
                  activeIndexSV={activeIndexSV}
                  isPlayingSV={isPlayingSV}
                  cFuture={cFuture}
                  cSpoken={cSpoken}
                  cActive={cActive}
                  glowColor={glowColor}
                />
              ))
            : text
          }
        </Text>
      </Pressable>
    );
  },
  chunkEqual,
);

// ─── Word ─────────────────────────────────────────────────────────────────────

const Word = React.memo(({ word, activeIndexSV, isPlayingSV, cFuture, cSpoken, cActive, glowColor }) => {
  const colorState = useSharedValue(0); // 0 future · 1 spoken · 2 active

  useAnimatedReaction(
    () => {
      const ai      = activeIndexSV.value;
      const playing = isPlayingSV.value === 1;
      if (word.globalIndex === ai && playing) return 2;
      if (word.globalIndex <= ai)             return 1;
      return 0;
    },
    (next, prev) => {
      "worklet";
      if (next === prev) return;
      if (prev === null) { colorState.value = next; return; }
      if (next === 2)              colorState.value = withTiming(2, { duration: 80 });
      else if (next === 1 && prev === 2)
        colorState.value = withTiming(1, { duration: 150, easing: Easing.out(Easing.quad) });
      else                         colorState.value = withTiming(next, { duration: 100 });
    },
  );

  const animStyle = useAnimatedStyle(() => ({
    color: interpolateColor(colorState.value, [0, 1, 2], [cFuture, cSpoken, cActive]),
    textShadowColor: interpolateColor(colorState.value, [1, 2], ["transparent", glowColor]),
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: interpolate(colorState.value, [1, 2], [0, 14], "clamp"),
  }));

  return (
    <Animated.Text selectable={false} style={[styles.wordText, animStyle]}>
      {word.text}
    </Animated.Text>
  );
});

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root:             { flex: 1, backgroundColor: "transparent" },
  container:        { flex: 1, backgroundColor: "transparent" },
  contentContainer: { paddingHorizontal: 24 },
  empty:            { flex: 1, alignItems: "center", justifyContent: "center" },
  placeholder:      { fontSize: 16, color: "#AEAEB2", textAlign: "center" },

  sentenceWrap: { marginBottom: 10 },
  wordText: { fontSize: 22, lineHeight: 28, fontWeight: "500" },

  keypointRow:  {
    flexDirection: "row",
    alignItems:    "center",
    height:        KEYPOINT_HEIGHT,
    marginBottom:  CHUNK_MARGIN,
  },
  keypointLine:  { flex: 1, height: 0.5, backgroundColor: "rgba(255,255,255,0.07)" },
  keypointLabel: { color: "#48485A", fontSize: 11, fontWeight: "700", letterSpacing: 1.2, paddingHorizontal: 10 },
});

// ─── Translation Modal ────────────────────────────────────────────────────────

const TranslationModal = ({ visible, text, contextText, onClose }) => {
  const { bottom } = useSafeAreaInsets();
  const [translationParts, setTranslationParts] = useState([]);
  const [loading,          setLoading]          = useState(false);
  const [error,            setError]            = useState(false);
  const [expanded,         setExpanded]         = useState(false);

  useEffect(() => {
    if (!visible || !contextText) return;
    setLoading(true); setTranslationParts([]); setError(false); setExpanded(false);
    fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=es&dt=t&q=${encodeURIComponent(contextText)}`)
      .then(r => r.json())
      .then(d => {
        const full  = d[0].map(c => c[0]).join("");
        const parts = full.split(/\n+/).map(p => p.trim()).filter(Boolean);
        setTranslationParts(parts.length ? parts : [full]);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [visible, contextText]);

  const lastTranslation  = translationParts[translationParts.length - 1] ?? "";
  const translatedCtx    = translationParts.slice(0, -1);
  const englishCtx       = (contextText ?? "").split(/\n\n+/).map(p => p.trim()).filter(Boolean).slice(0, -1);
  const hasContext       = translatedCtx.length > 0;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={ms.backdrop} onPress={onClose}>
        <Pressable style={ms.sheet} onPress={() => {}}>
          <View style={ms.handle} />
          <View style={ms.langRow}>
            <Text style={ms.lang}>English</Text>
            <Text style={ms.arrow}>→</Text>
            <Text style={ms.lang}>Español</Text>
          </View>

          {/* Scrollable body so expanded context never clips */}
          <ScrollView
            style={ms.scroll}
            contentContainerStyle={ms.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            {/* Context pairs — English + translation side by side */}
            {expanded && hasContext && translatedCtx.map((translated, i) => (
              <View key={i} style={ms.contextBlock}>
                <Text style={ms.contextEnglish}>{englishCtx[i] ?? ""}</Text>
                <Text style={ms.contextTranslated}>{translated}</Text>
                <View style={ms.contextDivider} />
              </View>
            ))}

            {/* Current paragraph */}
            <Text style={ms.originalText}>{text}</Text>
            <View style={ms.divider} />
            {loading ? <ActivityIndicator color="#4a90e2" style={{ marginVertical: 16 }} />
            : error  ? <Text style={ms.errorText}>Translation failed. Check your connection.</Text>
            : <>
                <Text style={ms.translatedText}>{lastTranslation}</Text>
                {hasContext && (
                  <TouchableOpacity onPress={() => setExpanded(e => !e)} style={ms.expandBtn}>
                    <Text style={ms.expandBtnText}>{expanded ? "Hide context" : "Show context"}</Text>
                  </TouchableOpacity>
                )}
              </>}
          </ScrollView>

          <TouchableOpacity style={[ms.closeBtn, { marginBottom: Math.max(bottom, 16) }]} onPress={onClose}>
            <Text style={ms.closeBtnText}>Close</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
};

const ms = StyleSheet.create({
  backdrop:          { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "flex-end" },
  sheet:             { backgroundColor: "#141416", borderTopLeftRadius: 24, borderTopRightRadius: 24,
                       padding: 24, paddingBottom: 0, borderTopWidth: 0.5, borderTopColor: "rgba(255,255,255,0.08)",
                       maxHeight: "85%" },
  handle:            { width: 36, height: 4, backgroundColor: "#3A3A3C", borderRadius: 2, alignSelf: "center", marginBottom: 22 },
  langRow:           { flexDirection: "row", alignItems: "center", marginBottom: 16, gap: 12 },
  lang:              { color: "#4FACFE", fontWeight: "700", fontSize: 14 },
  arrow:             { color: "#3A3A3C", fontSize: 14 },
  scroll:            { flexShrink: 1 },
  scrollContent:     { paddingBottom: 8 },
  // Previous context blocks — English + translation paired
  contextBlock:      { marginBottom: 4 },
  contextEnglish:    { color: "#48484A", fontSize: 13, lineHeight: 20, marginBottom: 6, fontStyle: "italic" },
  contextTranslated: { color: "#8E8E93", fontSize: 15, lineHeight: 22, marginBottom: 12 },
  contextDivider:    { height: 0.5, backgroundColor: "rgba(255,255,255,0.06)", marginBottom: 16 },
  // Current paragraph
  originalText:      { color: "#636366", fontSize: 16, lineHeight: 24, marginBottom: 16 },
  divider:           { height: 0.5, backgroundColor: "rgba(255,255,255,0.08)", marginBottom: 16 },
  translatedText:    { color: "#FFFFFF", fontSize: 19, lineHeight: 28, fontWeight: "600", marginBottom: 12, letterSpacing: -0.2 },
  expandBtn:         { alignSelf: "flex-start", marginBottom: 20 },
  expandBtnText:     { color: "#4FACFE", fontSize: 13, fontWeight: "600" },
  errorText:         { color: "#FF453A", fontSize: 15, marginBottom: 24 },
  closeBtn:          { alignSelf: "center", paddingVertical: 11, paddingHorizontal: 36, marginTop: 20,
                       backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 22, borderWidth: 0.5, borderColor: "rgba(255,255,255,0.1)" },
  closeBtnText:      { color: "#FFFFFF", fontWeight: "600", fontSize: 15 },
});

export default TranscriptHighlighter;
