import React, { useRef, useEffect, useCallback, useMemo } from 'react';
import {
    View,
    Text,
    FlatList,
    StyleSheet,
    Dimensions,
} from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, interpolateColor } from 'react-native-reanimated';
import { useProgress } from 'react-native-track-player';

const SCREEN_HEIGHT = Dimensions.get('window').height;
const CENTER_OFFSET = SCREEN_HEIGHT * 0.35;
const ANIMATION_DURATION = 125;

// Colour constants
const COLOR_FUTURE = '#303030';   // dark, barely visible
const COLOR_SPOKEN = '#888888';   // medium grey
const COLOR_ACTIVE  = '#ffffff';  // bright white

const TranscriptHighlighter = ({ segments }) => {
    const { position } = useProgress(80); // poll every 80ms
    const flatListRef      = useRef(null);
    const wordYPositions   = useRef({});
    const lastActiveIndex  = useRef(-1);

    // position from RNTP is seconds → ms
    // We add a +150ms offset to look slightly into the future. 
    // This allows the animation to start early and be fully bright *exactly* as the word is spoken.
    const posMs = (position * 1000) + 150;

    // 1. Group individual words into sentences/paragraphs (chunks) to avoid rendering 5000 views at once
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
            // Best effort to find end time, default to start + 2 seconds if missing to allow safe interpolation
            const endMs = seg.end_time ?? seg.end ?? (startMs + 2000);

            // Force split the segment into exact words to guarantee a true word-by-word effect,
            // even if the transcription API grouped multiple words into a single segment.
            const individualWords = rawText.split(/\s+/);
            const timePerWord = (endMs - startMs) / Math.max(1, individualWords.length);

            individualWords.forEach((wordText, wordIdx) => {
                if (currentChunk.length === 0) {
                    chunkStartMs = startMs + (wordIdx * timePerWord);
                }

                // Attach trailing space back to the word for rendering
                const isLastWord = wordIdx === individualWords.length - 1;
                const displayText = wordText + (isLastWord ? ' ' : ' ');

                currentChunk.push({
                    text: displayText,
                    startMs: startMs + (wordIdx * timePerWord),
                    globalIndex: globalWordIndex++
                });

                // Break the paragraph chunk if we hit a sentence end, or the paragraph is getting large
                const isEndOfSentence = wordText.endsWith('.') || wordText.endsWith('?') || wordText.endsWith('!');
                if (isEndOfSentence || currentChunk.length >= 35 || (i === segments.length - 1 && isLastWord)) {
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

    // Find the current active word index & which chunk it belongs to
    // Walk forward until we find a segment whose START is in the future
    let activeIndex = -1;
    let activeChunkIndex = 0;
    
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        let foundInChunk = false;
        for (let j = 0; j < chunk.words.length; j++) {
            const w = chunk.words[j];
            if (posMs >= w.startMs) {
                activeIndex = w.globalIndex;
                activeChunkIndex = i;
                foundInChunk = true;
            } else {
                break; // Because words are sequential, if we pass posMs we found it
            }
        }
        if (!foundInChunk && posMs < chunk.startMs) {
            break; // Stop looking in future chunks
        }
    }

    const lastActiveChunk = useRef(-1);

    // Smooth scroll to keep active chunk near centre
    const scrollToActive = useCallback((chunkIdx) => {
        if (flatListRef.current && chunkIdx >= 0 && chunkIdx < chunks.length) {
            flatListRef.current.scrollToIndex({
                index: chunkIdx,
                animated: true,
                viewPosition: 0.35, // 0 = top, 0.5 = center, 0.35 = slightly above center
            });
        }
    }, [chunks.length]);

    // Only scroll when the active CHUNK changes
    useEffect(() => {
        if (activeChunkIndex !== lastActiveChunk.current) {
            lastActiveChunk.current = activeChunkIndex;
            if (activeChunkIndex > -1) {
                scrollToActive(activeChunkIndex);
            }
        }
    }, [activeChunkIndex, scrollToActive]);

    if (!segments || segments.length === 0) {
        return (
            <View style={styles.empty}>
                <Text style={styles.placeholder}>No Transcript Available</Text>
            </View>
        );
    }

    const renderChunk = useCallback(({ item }) => {
        return <Chunk item={item} activeIndex={activeIndex} />;
    }, [activeIndex]);

    return (
        <FlatList
            ref={flatListRef}
            data={chunks}
            extraData={activeIndex}
            keyExtractor={item => item.id}
            renderItem={renderChunk}
            style={styles.container}
            contentContainerStyle={styles.contentContainer}
            showsVerticalScrollIndicator={false}
            scrollEventThrottle={16}
            ListHeaderComponent={<View style={{ height: CENTER_OFFSET }} />}
            ListFooterComponent={<View style={{ height: SCREEN_HEIGHT * 0.5 }} />}
            onScrollToIndexFailed={(info) => {
                const wait = new Promise(resolve => setTimeout(resolve, 500));
                wait.then(() => {
                    if (flatListRef.current) {
                        flatListRef.current.scrollToIndex({ index: info.index, animated: true, viewPosition: 0.35 });
                    }
                });
            }}
        />
    );
};

// Extracted Chunk component that only re-renders if the activeIndex crosses its boundary
const Chunk = React.memo(({ item, activeIndex }) => {
    return (
        <View style={styles.sentenceWrap}>
            {item.words.map((w) => (
                <Word key={w.globalIndex} word={w} activeIndex={activeIndex} />
            ))}
        </View>
    );
}, (prevProps, nextProps) => {
    if (prevProps.item !== nextProps.item) return false;
    
    // Only check activeIndex boundaries to prevent re-renders when the tracker is far away
    const words = prevProps.item.words;
    if (!words || words.length === 0) return true;
    
    const chunkStart = words[0].globalIndex;
    const chunkEnd = words[words.length - 1].globalIndex;
    const prevActive = prevProps.activeIndex;
    const nextActive = nextProps.activeIndex;
    
    // If the tracker is past this chunk in both renders, it's already 'spoken' (state=1)
    if (prevActive > chunkEnd && nextActive > chunkEnd) return true;
    // If the tracker is before this chunk in both renders, it's fully in the 'future' (state=0)
    if (prevActive < chunkStart && nextActive < chunkStart) return true;
    // Exactly the same tracker index -> no change
    if (prevActive === nextActive) return true;
    
    // Otherwise, the activeIndex entered, moved inside, or left the chunk -> must re-render!
    return false;
});

// Extracted Word component using react-native-reanimated for 60fps native fading
const Word = React.memo(({ word, activeIndex }) => {
    // Determine state: 0 = future, 1 = spoken, 2 = active
    const targetState = word.globalIndex < activeIndex ? 1 : word.globalIndex === activeIndex ? 2 : 0;
    const animState = useSharedValue(targetState);

    useEffect(() => {
        animState.value = withTiming(targetState, { duration: ANIMATION_DURATION });
    }, [targetState, animState]);

    const animatedStyle = useAnimatedStyle(() => {
        return {
            color: interpolateColor(
                animState.value,
                [0, 1, 2],
                [COLOR_FUTURE, COLOR_SPOKEN, COLOR_ACTIVE]
            ),
        };
    });

    return (
        <Animated.Text
            style={[
                styles.wordText,
                animatedStyle,
                targetState === 2 && styles.activeWeight,
            ]}
        >
            {word.text}
        </Animated.Text>
    );
}, (prevProps, nextProps) => {
    if (prevProps.word !== nextProps.word) return false;
    // Only re-render if its specific target state changes
    const getTarget = (idx) => prevProps.word.globalIndex < idx ? 1 : prevProps.word.globalIndex === idx ? 2 : 0;
    return getTarget(prevProps.activeIndex) === getTarget(nextProps.activeIndex);
});

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#0a0a0a',
    },
    contentContainer: {
        paddingHorizontal: 24,
    },
    empty: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#0a0a0a',
    },
    placeholder: {
        fontSize: 16,
        color: '#555',
        textAlign: 'center',
    },
    sentenceWrap: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'flex-start',
        marginBottom: 10,
    },
    wordText: {
        fontSize: 22,
        lineHeight: 28,
        marginRight: 0, // Space is directly appended to wordText now
        fontWeight: '500',
    },
    activeWeight: {
        fontWeight: '800',
    }
});

export default TranscriptHighlighter;
