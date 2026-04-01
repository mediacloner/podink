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
const LOOKAHEAD_MS    = 400;
const WORD_LEVEL_RADIUS      = 1;             // prev + current + next chunk → word-by-word
const KEYPOINT_INTERVAL_MS   = 10 * 60 * 1000;
const KEYPOINT_HEIGHT        = 36;            // fixed — used in both layout and scroll math

const COLOR_FUTURE = "#303030";
const COLOR_SPOKEN = "#888888";
const COLOR_ACTIVE = "#ffffff";

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


  // ── SharedValues (zero React re-renders) ──────────────────────────────────
  const activeIndexSV = useSharedValue(-1);
  const isPlayingSV   = useSharedValue(1);  // 1 = playing, 0 = paused

  useEffect(() => {
    isPlayingSV.value = playbackState.state === State.Playing ? 1 : 0;
  }, [playbackState.state, isPlayingSV]);

  // ── React state (scroll trigger only, ~every 2-5s) ────────────────────────
  const [activeChunkIndex, setActiveChunkIndex] = useState(-1);
  const activeChunkRef = useRef(-1); // mirrors state — read in renderItem without closure
  const prevChunkRef   = useRef(-1); // previous chunk — detects seek vs normal advance

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

  // ── Playback tick (100ms) ─────────────────────────────────────────────────

  useEffect(() => {
    const posMs = position * 1000 + LOOKAHEAD_MS;
    const idx   = findActiveIndex(wordTimings, posMs);
    activeIndexSV.value = idx;

    const ci = idx >= 0 ? (wordTimings[idx]?.chunkIndex ?? 0) : -1;
    if (ci !== activeChunkRef.current) {
      activeChunkRef.current = ci;
      setActiveChunkIndex(ci);
    }
  }, [position, wordTimings, activeIndexSV]);

  // ── Scroll computation ────────────────────────────────────────────────────
  //
  // Use the same itemOffsets table as getItemLayout.
  // itemOffsets[di] = content-absolute position of item di (includes LIST_HEADER).
  // Subtracting CENTER_OFFSET gives the scrollY that places the item at 35% from top.
  // Using the same table guarantees scroll position matches FlatList's internal layout.
  const computeScrollY = useCallback((targetDisplayIdx) => {
    const offset = itemOffsets[targetDisplayIdx] ?? CENTER_OFFSET;
    return Math.max(0, offset - CENTER_OFFSET);
  }, [itemOffsets]);

  // ── UI-thread scroll via Reanimated ──────────────────────────────────────
  //
  // Calling scrollTo() inside a worklet runs entirely on the native UI thread —
  // no JS bridge round-trip. On Android this eliminates the jank from JS-driven
  // scrollToOffset({ animated: true }) which goes JS → bridge → native each frame.
  //
  // runOnUI(fn)(args) serialises fn + args to the UI thread and executes immediately.
  const triggerScroll = useCallback((y, animated) => {
    runOnUI((targetY, doAnimate) => {
      "worklet";
      scrollTo(flatListRef, 0, targetY, doAnimate);
    })(y, animated);
  }, [flatListRef]);

  const scrollToActive = useCallback((chunkIdx) => {
    const di = chunkDisplayIndex[chunkIdx];
    if (di === undefined) return;

    const isSeek = Math.abs(chunkIdx - prevChunkRef.current) > 3;
    prevChunkRef.current = chunkIdx;

    // Don't fight the user reading ahead — but always honour external seeks.
    if (isUserScrollingRef.current && !isSeek) return;

    triggerScroll(computeScrollY(di), !isSeek);
  }, [chunkDisplayIndex, computeScrollY, triggerScroll]);

  useEffect(() => {
    if (activeChunkIndex > -1) scrollToActive(activeChunkIndex);
  }, [activeChunkIndex, scrollToActive]);

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

  // Stable — reads activeChunkRef (already updated before state fires).
  const renderItem = useCallback(({ item }) => {
    if (item.type === "keypoint") return <Keypoint item={item} />;
    const dist = Math.abs(item.chunkIndex - activeChunkRef.current);
    return (
      <Chunk
        item={item}
        isWordLevel={dist <= WORD_LEVEL_RADIUS}
        isPast={item.chunkIndex < activeChunkRef.current}
        activeIndexSV={activeIndexSV}
        isPlayingSV={isPlayingSV}
        onLongPress={onLongPress}
      />
    );
  }, [activeIndexSV, isPlayingSV, onLongPress]);

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
        extraData={activeChunkIndex}
        keyExtractor={item => item.id}
        renderItem={renderItem}
        getItemLayout={getItemLayout}
        style={styles.container}
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

const chunkEqual = (p, n) =>
  p.item        === n.item &&
  p.isWordLevel === n.isWordLevel &&
  p.isPast      === n.isPast;

const Chunk = React.memo(
  ({ item, isWordLevel, isPast, activeIndexSV, isPlayingSV, onLongPress }) => {
    const text = item.words.map(w => w.text).join("").trim();
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
  container:        { flex: 1, backgroundColor: "#0a0a0a" },
  contentContainer: { paddingHorizontal: 24 },
  empty:            { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0a0a0a" },
  placeholder:      { fontSize: 16, color: "#555", textAlign: "center" },

  sentenceWrap: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", marginBottom: 10 },
  wordText:     { fontSize: 22, lineHeight: 28, fontWeight: "500" },
  spokenText:   { color: COLOR_SPOKEN },
  futureText:   { color: COLOR_FUTURE },

  keypointRow:  {
    flexDirection: "row",
    alignItems:    "center",
    height:        KEYPOINT_HEIGHT, // matches constant used in computeScrollY + itemLengths
    marginBottom:  CHUNK_MARGIN,
  },
  keypointLine:  { flex: 1, height: 1, backgroundColor: "#1e1e1e" },
  keypointLabel: { color: "#3a3a3a", fontSize: 11, fontWeight: "700", letterSpacing: 1.2, paddingHorizontal: 10 },
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
  backdrop:       { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  sheet:          { backgroundColor: "#1e1e1e", borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24, paddingBottom: 36 },
  handle:         { width: 40, height: 4, backgroundColor: "#555", borderRadius: 2, alignSelf: "center", marginBottom: 20 },
  langRow:        { flexDirection: "row", alignItems: "center", marginBottom: 16, gap: 12 },
  lang:           { color: "#4a90e2", fontWeight: "700", fontSize: 14 },
  arrow:          { color: "#555", fontSize: 14 },
  originalText:   { color: "#888", fontSize: 16, lineHeight: 24, marginBottom: 16 },
  divider:        { height: 1, backgroundColor: "#333", marginBottom: 16 },
  translatedText: { color: "#fff", fontSize: 18, lineHeight: 28, fontWeight: "500", marginBottom: 24 },
  errorText:      { color: "#e24a4a", fontSize: 15, marginBottom: 24 },
  closeBtn:       { alignSelf: "center", paddingVertical: 10, paddingHorizontal: 32, backgroundColor: "#2a2a2a", borderRadius: 20 },
  closeBtnText:   { color: "#fff", fontWeight: "600", fontSize: 15 },
});

export default TranscriptHighlighter;
