import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    ActivityIndicator, FlatList, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import { Feather as Icon } from '@expo/vector-icons';
import SwipeableRow, { closeOpenRow } from '../components/SwipeableRow';
import EmptyState from '../components/EmptyState';
import { showAlert } from '../components/AppAlert';
import {
    getVocabWords, removeVocabWord, searchTranscripts,
} from '../services/vocabularyService';
import { getEpisodeById } from '../database/queries';
import { colors, withAlpha, type } from '../theme';

const formatTimestamp = (ms) => {
    const totalSec = Math.max(0, Math.floor((ms || 0) / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
};

// Context sentence with the saved word visually emphasized.
const ContextText = ({ context, word }) => {
    if (!context) return null;
    const idx = word ? context.toLowerCase().indexOf(word.toLowerCase()) : -1;
    if (idx < 0) {
        return <Text style={styles.context}>{context}</Text>;
    }
    return (
        <Text style={styles.context}>
            {context.slice(0, idx)}
            <Text style={styles.contextWord}>{context.slice(idx, idx + word.length)}</Text>
            {context.slice(idx + word.length)}
        </Text>
    );
};

const VocabRow = React.memo(({ item, expanded, onToggle, onPlay, onDelete }) => (
    <SwipeableRow
        rightAction={{
            icon: 'trash-2',
            color: colors.danger,
            dismiss: 'slide-out',
            onPress: () => onDelete(item),
            accessibilityLabel: `Remove ${item.word} from vocabulary`,
        }}
    >
        <TouchableOpacity
            style={styles.row}
            onPress={() => onToggle(item.id)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={`${item.word}${item.translation ? `, ${item.translation}` : ''}, ${expanded ? 'collapse' : 'expand'} context`}
        >
            <View style={styles.rowTop}>
                <Text style={styles.word} numberOfLines={1}>{item.word}</Text>
                {!!item.translation && (
                    <Text style={styles.translation} numberOfLines={1}>{item.translation}</Text>
                )}
            </View>
            <View style={styles.rowMeta}>
                <Icon name="headphones" size={11} color={colors.textFaint} />
                <Text style={styles.metaText} numberOfLines={1}>
                    {item.episode_title || 'Unknown episode'}
                </Text>
                <Text style={styles.timestamp}>{formatTimestamp(item.word_start_ms)}</Text>
            </View>

            {expanded && (
                <View style={styles.expandedBlock}>
                    <ContextText context={item.context_text} word={item.word} />
                    {!!item.definition && (
                        <Text style={styles.definition}>{item.definition}</Text>
                    )}
                    <TouchableOpacity
                        style={styles.playBtn}
                        onPress={() => onPlay(item.episode_id, item.word_start_ms)}
                        activeOpacity={0.7}
                        accessibilityRole="button"
                        accessibilityLabel={`Play episode at ${formatTimestamp(item.word_start_ms)}`}
                    >
                        <Icon name="play" size={13} color={colors.accent} />
                        <Text style={styles.playBtnText}>Play here</Text>
                    </TouchableOpacity>
                </View>
            )}
        </TouchableOpacity>
    </SwipeableRow>
));

const ResultRow = React.memo(({ item, onPlay }) => (
    <TouchableOpacity
        style={styles.row}
        onPress={() => onPlay(item.episode_id, item.start_time)}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`Play ${item.episode_title} at ${formatTimestamp(item.start_time)}`}
    >
        <Text style={styles.snippet} numberOfLines={2}>{item.snippet}</Text>
        <View style={styles.rowMeta}>
            <Icon name="play-circle" size={11} color={colors.accent} />
            <Text style={styles.metaText} numberOfLines={1}>
                {item.episode_title || 'Unknown episode'}
            </Text>
            <Text style={styles.timestamp}>{formatTimestamp(item.start_time)}</Text>
        </View>
    </TouchableOpacity>
));

const VocabularyScreen = ({ navigation }) => {
    const { bottom } = useSafeAreaInsets();
    const [words, setWords] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [query, setQuery] = useState('');
    const [transcriptResults, setTranscriptResults] = useState([]);
    const [expandedId, setExpandedId] = useState(null);
    const isFocused = useIsFocused();

    useEffect(() => {
        navigation.setOptions({
            headerStyle: { backgroundColor: colors.bg },
            headerTintColor: colors.textPrimary,
            headerTitleStyle: { fontWeight: '700', fontSize: 17, letterSpacing: -0.3 },
            headerShadowVisible: false,
            title: 'Vocabulary',
        });
    }, [navigation]);

    const loadWords = useCallback(async () => {
        try {
            const data = await getVocabWords();
            setWords(data || []);
        } catch (_) {
            setWords([]);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isFocused) loadWords();
    }, [isFocused, loadWords]);

    // Transcript search is debounced; saved words filter locally per keystroke.
    useEffect(() => {
        const q = query.trim();
        if (q.length < 2) {
            setTranscriptResults([]);
            return undefined;
        }
        let stale = false;
        const timer = setTimeout(async () => {
            try {
                const results = await searchTranscripts(q, 25);
                if (!stale) setTranscriptResults(results || []);
            } catch (_) {
                if (!stale) setTranscriptResults([]);
            }
        }, 300);
        return () => { stale = true; clearTimeout(timer); };
    }, [query]);

    const handleToggle = useCallback((id) => {
        setExpandedId(prev => (prev === id ? null : id));
    }, []);

    const handleDelete = useCallback(async (item) => {
        setWords(prev => prev.filter(w => w.id !== item.id));
        try {
            await removeVocabWord(item.id);
        } catch (_) {
            loadWords();
        }
    }, [loadWords]);

    const handlePlay = useCallback(async (episodeId, startMs) => {
        try {
            const episode = await getEpisodeById(episodeId);
            if (!episode) {
                showAlert('Episode unavailable', 'This episode is no longer in your library.');
                return;
            }
            navigation.navigate('Player', { episode, seekToMs: startMs || 0 });
        } catch (_) {
            showAlert('Episode unavailable', 'This episode is no longer in your library.');
        }
    }, [navigation]);

    const trimmedQuery = query.trim().toLowerCase();

    const listData = useMemo(() => {
        const filtered = trimmedQuery
            ? words.filter(w =>
                (w.word || '').toLowerCase().includes(trimmedQuery)
                || (w.translation || '').toLowerCase().includes(trimmedQuery)
                || (w.context_text || '').toLowerCase().includes(trimmedQuery))
            : words;

        const data = [];
        if (filtered.length > 0) {
            if (trimmedQuery) data.push({ type: 'header', key: 'h-saved', title: 'Saved words' });
            filtered.forEach(w => data.push({ type: 'word', key: `w-${w.id}`, item: w }));
        }
        if (trimmedQuery && transcriptResults.length > 0) {
            data.push({ type: 'header', key: 'h-transcripts', title: 'In transcripts' });
            transcriptResults.forEach((r, i) =>
                data.push({ type: 'result', key: `r-${r.episode_id}-${r.start_time}-${i}`, item: r }));
        }
        return data;
    }, [words, trimmedQuery, transcriptResults]);

    const renderItem = useCallback(({ item }) => {
        if (item.type === 'header') {
            return <Text style={styles.sectionLabel}>{item.title.toUpperCase()}</Text>;
        }
        if (item.type === 'result') {
            return <ResultRow item={item.item} onPlay={handlePlay} />;
        }
        return (
            <VocabRow
                item={item.item}
                expanded={expandedId === item.item.id}
                onToggle={handleToggle}
                onPlay={handlePlay}
                onDelete={handleDelete}
            />
        );
    }, [expandedId, handleToggle, handlePlay, handleDelete]);

    if (isLoading) {
        return (
            <View style={[styles.container, styles.loadingWrap]}>
                <ActivityIndicator size="large" color={colors.accent} />
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <View style={styles.searchWrap}>
                <Icon name="search" size={14} color={colors.textMuted} />
                <TextInput
                    style={styles.searchInput}
                    placeholder="Search words and transcripts…"
                    placeholderTextColor={colors.textMuted}
                    value={query}
                    onChangeText={setQuery}
                    autoCapitalize="none"
                    autoCorrect={false}
                    accessibilityLabel="Search vocabulary and transcripts"
                />
                {query.length > 0 && (
                    <TouchableOpacity
                        onPress={() => setQuery('')}
                        hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
                        accessibilityRole="button"
                        accessibilityLabel="Clear search"
                    >
                        <Icon name="x" size={14} color={colors.textMuted} />
                    </TouchableOpacity>
                )}
            </View>

            <FlatList
                data={listData}
                keyExtractor={item => item.key}
                renderItem={renderItem}
                contentContainerStyle={listData.length === 0 ? { flex: 1 } : { paddingBottom: bottom + 40 }}
                initialNumToRender={12}
                windowSize={7}
                onScrollBeginDrag={closeOpenRow}
                keyboardShouldPersistTaps="handled"
                ListEmptyComponent={
                    trimmedQuery ? (
                        <EmptyState
                            icon="search"
                            title="No matches"
                            subtitle="Nothing in your saved words or transcripts matches this search"
                        />
                    ) : (
                        <EmptyState
                            icon="bookmark"
                            title="No saved words yet"
                            subtitle="Tap any word in a transcript to save it"
                        />
                    )
                }
            />
        </View>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    loadingWrap: { alignItems: 'center', justifyContent: 'center' },

    searchWrap: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: colors.surface,
        borderRadius: 12,
        borderWidth: 0.5,
        borderColor: colors.hairline,
        paddingHorizontal: 14,
        height: 44,
        marginHorizontal: 16,
        marginTop: 12,
        marginBottom: 4,
    },
    searchInput: {
        flex: 1,
        color: colors.textPrimary,
        fontSize: 14,
        height: '100%',
    },

    sectionLabel: {
        ...type.caption,
        fontWeight: '700',
        color: colors.textMuted,
        letterSpacing: 0.7,
        paddingHorizontal: 20,
        marginTop: 20,
        marginBottom: 6,
    },

    row: {
        paddingHorizontal: 20,
        paddingVertical: 14,
        gap: 6,
        backgroundColor: colors.bg,
        borderBottomWidth: 0.5,
        borderBottomColor: colors.hairlineFaint,
    },
    rowTop: {
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: 10,
    },
    word: {
        fontSize: 17,
        fontWeight: '700',
        color: colors.textPrimary,
        flexShrink: 1,
    },
    translation: {
        ...type.bodyStrong,
        fontSize: 14,
        color: colors.accent,
        flexShrink: 1,
    },
    rowMeta: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    metaText: { flex: 1, fontSize: 12, color: colors.textMuted },
    timestamp: { fontSize: 12, fontWeight: '600', color: colors.textMuted },

    expandedBlock: {
        marginTop: 8,
        gap: 10,
    },
    context: {
        fontSize: 14,
        color: colors.textSecondary,
        lineHeight: 21,
    },
    contextWord: {
        color: colors.accent,
        fontWeight: '700',
    },
    definition: {
        fontSize: 13,
        color: colors.textMuted,
        lineHeight: 19,
        fontStyle: 'italic',
    },
    playBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        alignSelf: 'flex-start',
        gap: 6,
        minHeight: 44,
        paddingHorizontal: 16,
        borderRadius: 12,
        backgroundColor: withAlpha(colors.accent, 0.10),
        borderWidth: 0.5,
        borderColor: withAlpha(colors.accent, 0.25),
    },
    playBtnText: { ...type.bodyStrong, color: colors.accent },

    snippet: {
        fontSize: 14,
        color: colors.textSecondary,
        lineHeight: 21,
    },
});

export default VocabularyScreen;
