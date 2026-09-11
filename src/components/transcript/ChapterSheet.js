/**
 * ChapterSheet — the episode assistant's card in the Player: the summary,
 * the chapters (tap one to play from there) and the transcript fixes the
 * model proposed, each one there to be checked. Opens from the list glyph
 * in the Player header. Until an episode has been analysed it offers the
 * run, naming the model and what the run should cost; with no API key it
 * points at Settings. The pass itself is services/aiService.js.
 *
 * `episode` is the Player's episode row (summary, ai_indexed_at, ai_model
 * come from it; the Player refreshes it when 'analysis-indexed' fires).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import TrackPlayer from 'react-native-track-player';
import { Feather as Icon } from '@expo/vector-icons';
import { useTheme, useStyles, radii, withAlpha } from '../../theme';
import SheetModal, { SheetIconButton } from './SheetModal';
import { shareText } from './share';
import { getEpisodeChapters, getEpisodeFixes } from '../../database/queries';
import {
    analyzeEpisode, estimateEpisodeCost, getAIModel, getOpenAIKey, isAnalyzing, isFixTranscriptOn, modelInfo,
} from '../../services/aiService';
import { formatClock } from '../../services/sentenceBoundary';
import { onLibraryChange } from '../../services/libraryEvents';

const POSITION_POLL_MS = 1000;

const KIND_LABEL = { name: 'name', title: 'title', place: 'place', word: 'word' };

const ChapterSheet = ({ visible, onClose, episode, onSeek, onOpenSettings }) => {
    const { colors } = useTheme();
    const st = useStyles(makeStyles);
    const epId = episode?.id;

    const [chapters, setChapters] = useState([]);
    const [fixes, setFixes] = useState([]);
    const [hasKey, setHasKey] = useState(null);      // null = not read yet
    const [model, setModel] = useState(null);
    const [withFixes, setWithFixes] = useState(true);
    const [running, setRunning] = useState(false);
    const [error, setError] = useState(null);        // { message, kind }
    const [showFixes, setShowFixes] = useState(false);
    const [positionMs, setPositionMs] = useState(0);

    const load = useCallback(async () => {
        if (!epId) return;
        try {
            const [ch, fx] = await Promise.all([getEpisodeChapters(epId), getEpisodeFixes(epId)]);
            setChapters(ch || []);
            setFixes(fx || []);
        } catch (_) {}
    }, [epId]);

    useEffect(() => {
        if (!visible) return;
        setError(null);
        setShowFixes(false);
        load();
        getOpenAIKey().then(k => setHasKey(!!k)).catch(() => setHasKey(false));
        getAIModel().then(setModel).catch(() => {});
        isFixTranscriptOn().then(setWithFixes).catch(() => {});
        setRunning(isAnalyzing(epId));
    }, [visible, epId, load]);

    // A pass that lands while the sheet is open (this button, or the
    // after-transcription switch) fills the sheet in.
    useEffect(() => {
        if (!visible) return undefined;
        return onLibraryChange((p) => {
            if (p?.type === 'analysis-indexed' && p.episodeId === epId) { load(); setRunning(false); }
        });
    }, [visible, epId, load]);

    // Where the player is, once a second, to mark the chapter being heard.
    useEffect(() => {
        if (!visible || !chapters.length) return undefined;
        let alive = true;
        const tick = async () => {
            try {
                const { position } = await TrackPlayer.getProgress();
                if (alive) setPositionMs((position || 0) * 1000);
            } catch (_) {}
        };
        tick();
        const id = setInterval(tick, POSITION_POLL_MS);
        return () => { alive = false; clearInterval(id); };
    }, [visible, chapters.length]);

    const currentIdx = useMemo(() => {
        let idx = -1;
        chapters.forEach((c, i) => { if (c.start_ms <= positionMs + 500) idx = i; });
        return idx;
    }, [chapters, positionMs]);

    const run = useCallback(async () => {
        if (!epId || running) return;
        setError(null);
        setRunning(true);
        try {
            await analyzeEpisode(epId, { force: true });
            await load();
        } catch (e) {
            setError({ message: e?.message || 'Something went wrong.', kind: e?.kind });
        } finally {
            setRunning(false);
        }
    }, [epId, running, load]);

    const info = modelInfo(model);
    const costHint = estimateEpisodeCost(info.id, episode?.duration || 0, { fixes: withFixes });
    const summary = (episode?.summary || '').trim();
    const analysed = !!episode?.ai_indexed_at || chapters.length > 0;
    const appliedCount = fixes.filter(f => f.applied !== 0).length;

    // Title, summary, then one line per chapter — the blocks that have
    // something in them, a blank line between each.
    const onShare = useCallback(() => {
        const blocks = [[episode?.podcast_title, episode?.title].filter(Boolean).join(' — '), summary];
        if (chapters.length) {
            blocks.push(['Chapters', ...chapters.map(
                c => `[${formatClock(c.start_ms)}] ${c.title}${c.blurb ? ` — ${c.blurb}` : ''}`
            )].join('\n'));
        }
        shareText(blocks.filter(Boolean).join('\n\n'), 'Share summary');
    }, [episode, chapters, summary]);

    const seekTo = useCallback((ms) => { if (ms != null && onSeek) onSeek(ms); }, [onSeek]);

    const header = (
        <>
            <View style={st.labelRow}>
                <Icon name='list' size={13} color={colors.textMuted} />
                <Text style={st.label}>Summary and chapters</Text>
                <View style={{ flex: 1 }} />
                {analysed && !running && <SheetIconButton icon='refresh-cw' label='Write them again' onPress={run} />}
                {analysed && <SheetIconButton icon='share-2' label='Share the summary' onPress={onShare} />}
            </View>
            <Text style={st.title} numberOfLines={2}>{episode?.title || ''}</Text>
        </>
    );

    const when = episode?.ai_indexed_at ? new Date(episode.ai_indexed_at) : null;
    const caption = analysed
        ? `Written by ${episode?.ai_model || info.id}${when ? ` · ${when.toLocaleDateString()}` : ''}`
        : null;

    return (
        <SheetModal visible={visible} onClose={onClose} header={header} maxHeight='88%'>
            {running ? (
                <View style={st.runningRow}>
                    <ActivityIndicator size='small' color={colors.accent} />
                    <Text style={st.runningText}>Reading the transcript with {info.label}… a minute or two for an hour of audio.</Text>
                </View>
            ) : null}

            {!!error && !running && (
                <View style={st.errorBox}>
                    <Icon name='alert-circle' size={14} color={colors.danger} style={{ marginTop: 2 }} />
                    <View style={{ flex: 1, gap: 8 }}>
                        <Text style={st.errorText}>{error.message}</Text>
                        {(error.kind === 'nokey' || error.kind === 'auth') && !!onOpenSettings && (
                            <TouchableOpacity style={st.linkBtn} onPress={onOpenSettings} accessibilityRole='button'>
                                <Text style={st.linkText}>Open Settings</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                </View>
            )}

            {!analysed && !running ? (
                <View style={{ gap: 14 }}>
                    <Text style={st.body}>
                        A short summary of the episode, its chapters to jump between, and{withFixes ? ' corrections to misheard names and words in the transcript,' : ''} written by {info.id} at OpenAI from this transcript. The run should cost {costHint} in your OpenAI account.
                    </Text>
                    {hasKey === false ? (
                        <TouchableOpacity style={st.primaryBtn} onPress={onOpenSettings} activeOpacity={0.8} accessibilityRole='button'>
                            <Icon name='key' size={15} color={colors.onAccent} />
                            <Text style={st.primaryText}>Add your OpenAI API key in Settings</Text>
                        </TouchableOpacity>
                    ) : (
                        <TouchableOpacity style={st.primaryBtn} onPress={run} activeOpacity={0.8} accessibilityRole='button' disabled={hasKey === null}>
                            <Icon name='zap' size={15} color={colors.onAccent} />
                            <Text style={st.primaryText}>Summarise this episode</Text>
                        </TouchableOpacity>
                    )}
                </View>
            ) : null}

            {analysed ? (
                <View style={{ gap: 18 }}>
                    {!!summary && <Text style={st.summary}>{summary}</Text>}

                    {chapters.length ? (
                        <View style={st.chapterList}>
                            {chapters.map((c, i) => {
                                const current = i === currentIdx;
                                return (
                                    <TouchableOpacity
                                        key={c.id ?? i}
                                        style={[st.chapterRow, current && st.chapterRowCurrent, i < chapters.length - 1 && st.chapterRowBorder]}
                                        onPress={() => seekTo(c.start_ms)}
                                        activeOpacity={0.7}
                                        accessibilityRole='button'
                                        accessibilityLabel={`Play from ${formatClock(c.start_ms)}, ${c.title}`}
                                    >
                                        <Text style={[st.chapterTime, current && st.chapterTimeCurrent]}>{formatClock(c.start_ms)}</Text>
                                        <View style={{ flex: 1, gap: 2 }}>
                                            <Text style={[st.chapterTitle, current && st.chapterTitleCurrent]}>{c.title}</Text>
                                            {!!c.blurb && <Text style={st.chapterBlurb}>{c.blurb}</Text>}
                                        </View>
                                        {current && <Icon name='volume-2' size={14} color={colors.accent} style={{ marginTop: 2 }} />}
                                    </TouchableOpacity>
                                );
                            })}
                        </View>
                    ) : (
                        <Text style={st.muted}>No chapters were found in this transcript.</Text>
                    )}

                    {withFixes || fixes.length ? (
                        <View>
                            <TouchableOpacity style={st.fixHead} onPress={() => setShowFixes(v => !v)} activeOpacity={0.7} accessibilityRole='button'>
                                <Icon name='edit-3' size={13} color={colors.textMuted} />
                                <Text style={st.fixHeadText}>
                                    {fixes.length
                                        ? `Transcript corrections · ${appliedCount} applied${fixes.length > appliedCount ? `, ${fixes.length - appliedCount} held back` : ''}`
                                        : 'Transcript corrections · none'}
                                </Text>
                                <View style={{ flex: 1 }} />
                                {fixes.length ? <Icon name={showFixes ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textMuted} /> : null}
                            </TouchableOpacity>
                            {showFixes && fixes.map((f, i) => (
                                <TouchableOpacity
                                    key={`${f.heard}-${i}`}
                                    style={[st.fixRow, f.applied === 0 && st.fixRowOff]}
                                    onPress={() => seekTo(f.first_ms)}
                                    activeOpacity={0.7}
                                    accessibilityRole='button'
                                    accessibilityLabel={`Play where "${f.heard}" was said`}
                                >
                                    <View style={{ flex: 1, gap: 2 }}>
                                        <Text style={st.fixLine}>
                                            <Text style={st.fixHeard}>{f.heard}</Text>
                                            <Text style={st.fixArrow}>  →  </Text>
                                            <Text style={st.fixCorrect}>{f.correct}</Text>
                                        </Text>
                                        <Text style={st.fixMeta}>
                                            {KIND_LABEL[f.kind] || 'word'} · {f.confidence || 'high'}{f.applied === 0 ? ' · not applied' : ''}{f.count > 1 ? ` · ×${f.count}` : ''}{f.first_ms != null ? ` · ${formatClock(f.first_ms)}` : ''}
                                        </Text>
                                        {!!f.context && <Text style={st.fixContext} numberOfLines={2}>{f.context}</Text>}
                                    </View>
                                </TouchableOpacity>
                            ))}
                        </View>
                    ) : null}

                    {!!caption && <Text style={st.caption}>{caption}</Text>}
                </View>
            ) : null}
        </SheetModal>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    labelRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
    label: { fontSize: 12, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', color: colors.textMuted },
    title: { fontSize: 18, fontWeight: '700', color: colors.textPrimary, lineHeight: 24, marginBottom: 14 },

    body: { fontSize: 15, lineHeight: 22, color: colors.textSecondary },
    muted: { fontSize: 14, color: colors.textMuted },
    summary: { fontSize: 16, lineHeight: 24, color: colors.textPrimary },
    caption: { fontSize: 12, color: colors.textMuted, marginBottom: 8 },

    runningRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, marginBottom: 12 },
    runningText: { flex: 1, fontSize: 14, lineHeight: 20, color: colors.textSecondary },

    errorBox: {
        flexDirection: 'row', gap: 10, padding: 12, marginBottom: 14, borderRadius: radii.m,
        backgroundColor: withAlpha(colors.danger, 0.1), borderWidth: 0.5, borderColor: withAlpha(colors.danger, 0.35),
    },
    errorText: { fontSize: 14, lineHeight: 20, color: colors.textPrimary },
    linkBtn: { alignSelf: 'flex-start' },
    linkText: { color: colors.accent, fontSize: 14, fontWeight: '700' },

    primaryBtn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
        paddingVertical: 13, paddingHorizontal: 18, borderRadius: radii.pill, backgroundColor: colors.accent,
    },
    primaryText: { color: colors.onAccent, fontSize: 15, fontWeight: '700' },

    chapterList: { borderRadius: radii.m, borderWidth: 0.5, borderColor: colors.hairline, overflow: 'hidden' },
    chapterRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 12, paddingHorizontal: 14 },
    chapterRowBorder: { borderBottomWidth: 0.5, borderBottomColor: colors.hairline },
    chapterRowCurrent: { backgroundColor: withAlpha(colors.accent, 0.1) },
    chapterTime: { width: 52, fontSize: 13, fontWeight: '700', color: colors.textMuted, fontVariant: ['tabular-nums'], marginTop: 1 },
    chapterTimeCurrent: { color: colors.accent },
    chapterTitle: { fontSize: 15, fontWeight: '600', color: colors.textPrimary, lineHeight: 20 },
    chapterTitleCurrent: { color: colors.accent },
    chapterBlurb: { fontSize: 13, lineHeight: 18, color: colors.textSecondary },

    fixHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
    fixHeadText: { fontSize: 13, fontWeight: '700', color: colors.textMuted },
    fixRow: { paddingVertical: 10, borderTopWidth: 0.5, borderTopColor: colors.hairline },
    fixRowOff: { opacity: 0.55 },
    fixLine: { fontSize: 15, lineHeight: 21 },
    fixHeard: { color: colors.textMuted, textDecorationLine: 'line-through' },
    fixArrow: { color: colors.textMuted },
    fixCorrect: { color: colors.textPrimary, fontWeight: '700' },
    fixMeta: { fontSize: 12, color: colors.textMuted },
    fixContext: { fontSize: 13, lineHeight: 18, color: colors.textSecondary, fontStyle: 'italic', marginTop: 2 },
});

export default ChapterSheet;
