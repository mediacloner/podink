import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Animated, {
  Easing,
  interpolateColor,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useProgress } from "react-native-track-player";

const SCREEN_HEIGHT = Dimensions.get("window").height;
const CENTER_OFFSET = SCREEN_HEIGHT * 0.35;
const ANIMATION_DURATION = 125;
const CHUNK_MARGIN = 10; // must match sentenceWrap.marginBottom
// How many ms ahead of the audio the highlight leads.
// Makes the word light up just before you hear it — feels more natural.
const LOOKAHEAD_MS = 250;

const LIST_HEADER = <View style={{ height: CENTER_OFFSET }} />;
const LIST_FOOTER = <View style={{ height: SCREEN_HEIGHT * 0.5 }} />;

const COLOR_FUTURE = "#303030";
const COLOR_SPOKEN = "#888888";
const COLOR_ACTIVE = "#ffffff";

// O(log n) binary search: returns the globalIndex of the last word whose startMs <= posMs.
// wordTimings is a flat array sorted by startMs, indexed by globalIndex.
function findActiveIndex(wordTimings, posMs) {
  if (wordTimings.length === 0 || posMs < wordTimings[0].startMs) return -1;
  let lo = 0;
  let hi = wordTimings.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (wordTimings[mid].startMs <= posMs) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return wordTimings[lo].startMs <= posMs ? lo : -1;
}

const TranscriptHighlighter = ({ segments }) => {
  const { position } = useProgress(100);
  const flatListRef = useRef(null);
  // Each chunk reports its rendered height via onLayout.
  // We accumulate them to compute the real Y offset inside the scroll content,
  // which lets us use scrollToOffset (exact pixels) instead of scrollToIndex
  // (internal lookup that can feel abrupt).
  const chunkHeights = useRef({});

  // SharedValue: updating this triggers zero React re-renders.
  // Word components subscribe to it directly on the UI thread.
  const activeIndexSV = useSharedValue(-1);

  // React state only for scroll — changes every ~2-5 seconds, not every 100ms.
  const [activeChunkIndex, setActiveChunkIndex] = useState(-1);
  const activeChunkRef = useRef(-1);

  const chunks = useMemo(() => {
    if (!segments || segments.length === 0) return [];
    const result = [];
    let currentChunk = [];
    let chunkStartMs = 0;
    let globalWordIndex = 0;

    segments.forEach((seg, i) => {
      const rawText = seg.text.trim();
      if (!rawText) return;

      const startMs = seg.start_time ?? seg.start ?? 0;
      const endMs = seg.end_time ?? seg.end ?? startMs + 2000;
      const individualWords = rawText.split(/\s+/).filter(Boolean);
      const timePerWord =
        (endMs - startMs) / Math.max(1, individualWords.length);

      individualWords.forEach((wordText, wordIdx) => {
        if (currentChunk.length === 0) {
          chunkStartMs = startMs + wordIdx * timePerWord;
        }

        currentChunk.push({
          text: wordText + " ",
          startMs: startMs + wordIdx * timePerWord,
          globalIndex: globalWordIndex++,
        });

        const isLastWord = wordIdx === individualWords.length - 1;
        const isEndOfSentence =
          wordText.endsWith(".") ||
          wordText.endsWith("?") ||
          wordText.endsWith("!");
        if (
          isEndOfSentence ||
          currentChunk.length >= 35 ||
          (i === segments.length - 1 && isLastWord)
        ) {
          result.push({
            id: `chunk-${result.length}`,
            words: currentChunk,
            startMs: chunkStartMs,
            chunkIndex: result.length,
          });
          currentChunk = [];
        }
      });
    });
    return result;
  }, [segments]);

  // Flat sorted array for binary search: wordTimings[globalIndex] = { startMs, chunkIndex }
  const wordTimings = useMemo(() => {
    const arr = [];
    chunks.forEach((chunk, chunkIdx) => {
      chunk.words.forEach((w) => {
        arr[w.globalIndex] = { startMs: w.startMs, chunkIndex: chunkIdx };
      });
    });
    return arr;
  }, [chunks]);

  // Runs every 100ms. Binary search is O(log n).
  // Writing to a SharedValue does NOT trigger a React re-render.
  // setActiveChunkIndex fires only when the active chunk changes (~every 2-5s).
  useEffect(() => {
    const posMs = position * 1000 + LOOKAHEAD_MS;
    const idx = findActiveIndex(wordTimings, posMs);

    activeIndexSV.value = idx;

    const chunkIdx = idx >= 0 ? (wordTimings[idx]?.chunkIndex ?? 0) : 0;
    if (chunkIdx !== activeChunkRef.current) {
      activeChunkRef.current = chunkIdx;
      setActiveChunkIndex(chunkIdx);
    }
  }, [position, wordTimings, activeIndexSV]);

  const scrollToActive = useCallback((chunkIdx) => {
    if (!flatListRef.current || chunkIdx < 0 || chunkIdx >= chunks.length) return;

    // Sum the heights of all chunks before the target to get its exact Y in the content.
    // onLayout.height is accurate; we add CHUNK_MARGIN per chunk since margin is not
    // included in the measured height but does occupy space between items.
    let y = CENTER_OFFSET; // ListHeaderComponent height
    for (let i = 0; i < chunkIdx; i++) {
      const h = chunkHeights.current[i];
      if (h === undefined) {
        // Chunk not rendered/measured yet — fall back to index scroll.
        flatListRef.current.scrollToIndex({ index: chunkIdx, animated: true, viewPosition: 0.35 });
        return;
      }
      y += h + CHUNK_MARGIN;
    }

    flatListRef.current.scrollToOffset({
      offset: Math.max(0, y - CENTER_OFFSET),
      animated: true,
    });
  }, [chunks.length]);

  // Scroll only when the active chunk changes — not on every word tick.
  useEffect(() => {
    if (activeChunkIndex > -1) {
      scrollToActive(activeChunkIndex);
    }
  }, [activeChunkIndex, scrollToActive]);

  const onChunkLayout = useCallback((chunkIdx, height) => {
    chunkHeights.current[chunkIdx] = height;
  }, []);

  const [translateModal, setTranslateModal] = useState({ visible: false, text: "" });

  const onChunkLongPress = useCallback((text) => {
    setTranslateModal({ visible: true, text });
  }, []);

  const closeModal = useCallback(() => {
    setTranslateModal({ visible: false, text: "" });
  }, []);

  // All callbacks are stable refs — renderChunk never recreates during playback.
  const renderChunk = useCallback(
    ({ item }) => (
      <Chunk
        item={item}
        activeIndexSV={activeIndexSV}
        onLayout={onChunkLayout}
        onLongPress={onChunkLongPress}
      />
    ),
    [activeIndexSV, onChunkLayout, onChunkLongPress],
  );

  if (!segments || segments.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.placeholder}>No Transcript Available</Text>
      </View>
    );
  }

  return (
    <>
    <TranslationModal
      visible={translateModal.visible}
      text={translateModal.text}
      onClose={closeModal}
    />
    <FlatList
      ref={flatListRef}
      data={chunks}
      // No extraData — FlatList re-renders only when activeChunkIndex (React state) changes.
      keyExtractor={(item) => item.id}
      renderItem={renderChunk}
      style={styles.container}
      contentContainerStyle={styles.contentContainer}
      showsVerticalScrollIndicator={false}
      scrollEventThrottle={16}
      initialNumToRender={10}
      maxToRenderPerBatch={5}
      windowSize={10}
      ListHeaderComponent={LIST_HEADER}
      ListFooterComponent={LIST_FOOTER}
      onScrollToIndexFailed={(info) => {
        // Fallback for the rare case a chunk isn't measured yet.
        flatListRef.current?.scrollToOffset({
          offset: info.averageItemLength * info.index,
          animated: true,
        });
      }}
    />
    </>
  );
};

// Chunk re-renders only when segments change (item ref changes).
// During playback, all props are stable — this never re-renders.
const Chunk = React.memo(({ item, activeIndexSV, onLayout, onLongPress }) => {
  const text = item.words.map((w) => w.text).join("").trim();
  return (
    <Pressable
      onLongPress={() => onLongPress(text)}
      delayLongPress={400}
      onLayout={(e) => onLayout(item.chunkIndex, e.nativeEvent.layout.height)}
      style={styles.sentenceWrap}
    >
      {item.words.map((w) => (
        <Word key={w.globalIndex} word={w} activeIndexSV={activeIndexSV} />
      ))}
    </Pressable>
  );
});

// Word drives its own color entirely on the UI thread via Reanimated.
// React never re-renders this component during playback.
//
// Asymmetric timing gives the Apple Podcasts "lingering glow" feel:
//   → active:          80ms  (snappy light-up)
//   active → spoken:  450ms  ease-out (word fades gracefully after being spoken)
//   other:            150ms  (seeking, skipping)
const Word = React.memo(({ word, activeIndexSV }) => {
  const colorState = useSharedValue(0); // 0=future, 1=spoken, 2=active

  useAnimatedReaction(
    () => {
      const ai = activeIndexSV.value;
      if (word.globalIndex === ai) return 2;
      if (word.globalIndex < ai) return 1;
      return 0;
    },
    (next, prev) => {
      if (next === prev) return;

      // On first mount set the correct state instantly — no animation needed.
      if (prev === null) {
        colorState.value = next;
        return;
      }

      if (next === 2) {
        // → active: snap on quickly so it feels responsive
        colorState.value = withTiming(2, { duration: 80 });
      } else if (next === 1 && prev === 2) {
        // active → spoken: linger bright, then ease out slowly (the "glow" effect)
        colorState.value = withTiming(1, {
          duration: 450,
          easing: Easing.out(Easing.quad),
        });
      } else {
        // future → spoken (seek forward) or spoken → future (seek back): quick
        colorState.value = withTiming(next, { duration: 150 });
      }
    },
  );

  const animatedStyle = useAnimatedStyle(() => ({
    color: interpolateColor(
      colorState.value,
      [0, 1, 2],
      [COLOR_FUTURE, COLOR_SPOKEN, COLOR_ACTIVE],
    ),
  }));

  return (
    <Animated.Text selectable={false} style={[styles.wordText, animatedStyle]}>
      {word.text}
    </Animated.Text>
  );
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0a0a0a",
  },
  contentContainer: {
    paddingHorizontal: 24,
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0a0a0a",
  },
  placeholder: {
    fontSize: 16,
    color: "#555",
    textAlign: "center",
  },
  sentenceWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    marginBottom: 10,
  },
  wordText: {
    fontSize: 22,
    lineHeight: 28,
    fontWeight: "500",
  },
});

const TranslationModal = ({ visible, text, onClose }) => {
  const [translation, setTranslation] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!visible || !text) return;
    setLoading(true);
    setTranslation("");
    setError(false);

    fetch(
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=es&dt=t&q=${encodeURIComponent(text)}`
    )
      .then((r) => r.json())
      .then((data) => {
        const result = data[0].map((chunk) => chunk[0]).join("");
        setTranslation(result);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [visible, text]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={modalStyles.backdrop} onPress={onClose}>
        <Pressable style={modalStyles.sheet} onPress={() => {}}>
          <View style={modalStyles.handle} />

          <View style={modalStyles.langRow}>
            <Text style={modalStyles.lang}>English</Text>
            <Text style={modalStyles.arrow}>→</Text>
            <Text style={modalStyles.lang}>Español</Text>
          </View>

          <Text style={modalStyles.originalText}>{text}</Text>

          <View style={modalStyles.divider} />

          {loading ? (
            <ActivityIndicator color="#4a90e2" style={{ marginVertical: 16 }} />
          ) : error ? (
            <Text style={modalStyles.errorText}>Translation failed. Check your connection.</Text>
          ) : (
            <Text style={modalStyles.translatedText}>{translation}</Text>
          )}

          <TouchableOpacity style={modalStyles.closeBtn} onPress={onClose}>
            <Text style={modalStyles.closeBtnText}>Close</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
};

const modalStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "#1e1e1e",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 36,
  },
  handle: {
    width: 40,
    height: 4,
    backgroundColor: "#555",
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: 20,
  },
  langRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 16,
    gap: 12,
  },
  lang: {
    color: "#4a90e2",
    fontWeight: "700",
    fontSize: 14,
  },
  arrow: {
    color: "#555",
    fontSize: 14,
  },
  originalText: {
    color: "#888",
    fontSize: 16,
    lineHeight: 24,
    marginBottom: 16,
  },
  divider: {
    height: 1,
    backgroundColor: "#333",
    marginBottom: 16,
  },
  translatedText: {
    color: "#fff",
    fontSize: 18,
    lineHeight: 28,
    fontWeight: "500",
    marginBottom: 24,
  },
  errorText: {
    color: "#e24a4a",
    fontSize: 15,
    marginBottom: 24,
  },
  closeBtn: {
    alignSelf: "center",
    paddingVertical: 10,
    paddingHorizontal: 32,
    backgroundColor: "#2a2a2a",
    borderRadius: 20,
  },
  closeBtnText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 15,
  },
});

export default TranscriptHighlighter;
