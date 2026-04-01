import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Animated, {
  Easing,
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
import { useProgress, usePlaybackState, State } from "react-native-track-player";

// ─── Constants ───────────────────────────────────────────────────────────────

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get("window");
const CONTENT_WIDTH   = SCREEN_WIDTH - 48;    // paddingHorizontal: 24 * 2
const CENTER_OFFSET   = SCREEN_HEIGHT * 0.35; // active chunk sits 35% from top
const CHUNK_MARGIN    = 10;                   // matches sentenceWrap.marginBottom
const FONT_SIZE       = 22;
const LINE_HEIGHT     = 28;
const CHAR_WIDTH      = FONT_SIZE * 0.52;     // empirical ratio for weight 500
const LOOKAHEAD_MS    = 550;
const WORD_LEVEL_RADIUS      = 1;             // prev + current + next chunk → word-by-word
const KEYPOINT_INTERVAL_MS   = 10 * 60 * 1000;
const KEYPOINT_HEIGHT        = 36;            // fixed — used in both layout and scroll math

const COLOR_FUTURE = "#2A2A2C";
const COLOR_SPOKEN = "#7A7A7E";
const COLOR_ACTIVE = "#FFFFFF";

const LIST_HEADER = <View style={{ height: CENTER_OFFSET }} />;
const LIST_FOOTER = <View style={{ height: SCREEN_HEIGHT * 0.5 }} />;

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:00` : `${m}:00`;
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

const TranscriptHighlighter = ({ segments }) => {
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

  const prevChunkRef = useRef(-1); // detects seek vs normal advance

  // Manual scroll detection — suppresses auto-follow while user reads ahead.
  const isUserScrollingRef   = useRef(false);
  const userScrollTimeoutRef = useRef(null);

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
    let y = CENTER_OFFSET; // first item sits after the LIST_HEADER
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

  // Normal advance: smooth animated scroll, no opacity change.
  const triggerScroll = useCallback((y, animated) => {
    runOnUI((targetY, doAnimate) => {
      "worklet";
      scrollTo(flatListRef, 0, targetY, doAnimate);
    })(y, animated);
  }, [flatListRef]);

  // Seek (large jump): fade out → instant scroll → fade in.
  // Runs entirely on the UI thread so there's no bridge delay between the
  // fade-out completing and the scroll firing.
  const triggerSeekScroll = useCallback((y) => {
    runOnUI((targetY) => {
      "worklet";
      opacitySV.value = withTiming(0, { duration: 120 }, (finished) => {
        "worklet";
        if (finished) {
          scrollTo(flatListRef, 0, targetY, false);
          opacitySV.value = withTiming(1, { duration: 200, easing: Easing.out(Easing.quad) });
        }
      });
    })(y);
  }, [flatListRef, opacitySV]);

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
          triggerSeekScroll(scrollY);
        } else if (!isUserScrollingRef.current) {
          triggerScroll(scrollY, true);
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
  }, []);

  const resumeAutoScroll = useCallback((delay) => {
    clearTimeout(userScrollTimeoutRef.current);
    userScrollTimeoutRef.current = setTimeout(() => {
      isUserScrollingRef.current = false;
    }, delay);
  }, []);

  // Resume 3s after finger lifts; 1s after momentum ends (inertia finished).
  const onScrollEndDrag      = useCallback(() => resumeAutoScroll(3000), [resumeAutoScroll]);
  const onMomentumScrollEnd  = useCallback(() => resumeAutoScroll(1000), [resumeAutoScroll]);

  // ── Translation modal ─────────────────────────────────────────────────────

  const [translateModal, setTranslateModal] = useState({ visible: false, text: "" });
  const onLongPress = useCallback((text) => setTranslateModal({ visible: true, text }), []);
  const closeModal  = useCallback(() => setTranslateModal({ visible: false, text: "" }), []);

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
      />
    );
  }, [activeChunkSV, activeIndexSV, isPlayingSV, onLongPress]);

  if (!segments?.length) {
    return (
      <View style={styles.empty}>
        <Text style={styles.placeholder}>No Transcript Available</Text>
      </View>
    );
  }

  return (
    <>
      <TranslationModal visible={translateModal.visible} text={translateModal.text} onClose={closeModal} />
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
        onScrollBeginDrag={onScrollBeginDrag}
        onScrollEndDrag={onScrollEndDrag}
        onMomentumScrollEnd={onMomentumScrollEnd}
        onScrollToIndexFailed={() => {}}
      />
    </>
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

const chunkEqual = (p, n) => p.item === n.item; // item is stable; all other props are SharedValues

const Chunk = React.memo(
  ({ item, activeChunkSV, activeIndexSV, isPlayingSV, onLongPress }) => {
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
        onLongPress={() => onLongPress(text)}
        delayLongPress={400}
        style={styles.sentenceWrap}
      >
        {isWordLevel
          ? item.words.map(w => (
              <Word key={w.globalIndex} word={w} activeIndexSV={activeIndexSV} isPlayingSV={isPlayingSV} />
            ))
          : <Text style={[styles.wordText, isPast ? styles.spokenText : styles.futureText]}>{text}</Text>
        }
      </Pressable>
    );
  },
  chunkEqual,
);

// ─── Word ─────────────────────────────────────────────────────────────────────

const Word = React.memo(({ word, activeIndexSV, isPlayingSV }) => {
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
    color: interpolateColor(colorState.value, [0, 1, 2], [COLOR_FUTURE, COLOR_SPOKEN, COLOR_ACTIVE]),
  }));

  return (
    <Animated.Text selectable={false} style={[styles.wordText, animStyle]}>
      {word.text}
    </Animated.Text>
  );
});

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:        { flex: 1, backgroundColor: "#0C0C0E" },
  contentContainer: { paddingHorizontal: 24 },
  empty:            { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0C0C0E" },
  placeholder:      { fontSize: 16, color: "#555", textAlign: "center" },

  sentenceWrap: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", marginBottom: 10 },
  wordText:     { fontSize: 22, lineHeight: 28, fontWeight: "500" },
  spokenText:   { color: COLOR_SPOKEN },
  futureText:   { color: COLOR_FUTURE },

  keypointRow:  {
    flexDirection: "row",
    alignItems:    "center",
    height:        KEYPOINT_HEIGHT, // matches constant used in itemOffsets + itemLengths
    marginBottom:  CHUNK_MARGIN,
  },
  keypointLine:  { flex: 1, height: 0.5, backgroundColor: "rgba(255,255,255,0.06)" },
  keypointLabel: { color: "#3A3A3C", fontSize: 11, fontWeight: "700", letterSpacing: 1.2, paddingHorizontal: 10 },
});

// ─── Translation Modal ────────────────────────────────────────────────────────

const TranslationModal = ({ visible, text, onClose }) => {
  const [translation, setTranslation] = useState("");
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState(false);

  useEffect(() => {
    if (!visible || !text) return;
    setLoading(true); setTranslation(""); setError(false);
    fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=es&dt=t&q=${encodeURIComponent(text)}`)
      .then(r => r.json())
      .then(d => setTranslation(d[0].map(c => c[0]).join("")))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [visible, text]);

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
          <Text style={ms.originalText}>{text}</Text>
          <View style={ms.divider} />
          {loading  ? <ActivityIndicator color="#4a90e2" style={{ marginVertical: 16 }} />
          : error   ? <Text style={ms.errorText}>Translation failed. Check your connection.</Text>
          :           <Text style={ms.translatedText}>{translation}</Text>}
          <TouchableOpacity style={ms.closeBtn} onPress={onClose}>
            <Text style={ms.closeBtnText}>Close</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
};

const ms = StyleSheet.create({
  backdrop:       { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "flex-end" },
  sheet:          { backgroundColor: "#141416", borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 40, borderTopWidth: 0.5, borderTopColor: "rgba(255,255,255,0.08)" },
  handle:         { width: 36, height: 4, backgroundColor: "#3A3A3C", borderRadius: 2, alignSelf: "center", marginBottom: 22 },
  langRow:        { flexDirection: "row", alignItems: "center", marginBottom: 16, gap: 12 },
  lang:           { color: "#4FACFE", fontWeight: "700", fontSize: 14 },
  arrow:          { color: "#3A3A3C", fontSize: 14 },
  originalText:   { color: "#636366", fontSize: 16, lineHeight: 24, marginBottom: 16 },
  divider:        { height: 0.5, backgroundColor: "rgba(255,255,255,0.08)", marginBottom: 16 },
  translatedText: { color: "#FFFFFF", fontSize: 19, lineHeight: 28, fontWeight: "600", marginBottom: 28, letterSpacing: -0.2 },
  errorText:      { color: "#FF453A", fontSize: 15, marginBottom: 24 },
  closeBtn:       { alignSelf: "center", paddingVertical: 11, paddingHorizontal: 36, backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 22, borderWidth: 0.5, borderColor: "rgba(255,255,255,0.1)" },
  closeBtnText:   { color: "#FFFFFF", fontWeight: "600", fontSize: 15 },
});

export default TranscriptHighlighter;
