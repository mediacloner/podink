import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator, Image, Keyboard, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather as Icon } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { showAlert } from '../components/AppAlert';
import { formatDuration } from '../components/EpisodeItem';
import { getEpisodeById } from '../database/queries';
import {
    cancelYouTubeImport, clearYouTubeImport, describeYouTubeImportError, importYouTubeVideo,
    isYouTubeImportSupported, isYouTubeUrl, useYouTubeImport,
} from '../services/youtubeService';
import { useTranscriptionQueue } from '../hooks/useTranscriptionQueue';
import { onLibraryChange } from '../services/libraryEvents';
import { artworkSource } from '../api/userAgent';
import { log } from '../services/logService';
import { radii, type, useStyles, useTheme, withAlpha } from '../theme';

const formatMb = (n) => `${Math.max(0, n / 1024 / 1024).toFixed(n >= 100 * 1024 * 1024 ? 0 : 1)} MB`;

/**
 * Import from YouTube (4.1.0): a link goes in, an episode with a transcript
 * comes out. The form takes a pasted link (or the one a share / the Feed's
 * add box arrived with, started on its own); the card below follows the one
 * import the service runs — reading the page, the download with its
 * progress, the row being saved, then the transcription's own progress —
 * and ends with Open in Player. The state is the service's, so leaving and
 * coming back shows where the import is.
 */
const YouTubeImportScreen = ({ navigation, route }) => {
    const { url: urlParam = '', autoStart = false, nonce = 0 } = route.params || {};
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const { bottom } = useSafeAreaInsets();
    const job = useYouTubeImport();
    const { activeId, queuedIds } = useTranscriptionQueue();
    const [input, setInput] = useState(urlParam || '');
    const [transcript, setTranscript] = useState(null); // { percent } | 'done' | 'error'
    const lastAutoRef = useRef(null);

    const active = !!job && job.stage !== 'done' && job.stage !== 'error';
    const valid = isYouTubeUrl(input);

    const start = useCallback(async (text) => {
        const value = String(text ?? input).trim();
        if (!value) return;
        Keyboard.dismiss();
        log('UI', 'YouTube import tapped', { input: value.slice(0, 200) });
        try {
            await importYouTubeVideo(value);
        } catch (e) {
            // Failures inside the import show in the card; these never made a job.
            if (e?.code === 'BUSY' || e?.code === 'NOT_YOUTUBE' || e?.code === 'OFFLINE' || e?.code === 'UNSUPPORTED') {
                const d = describeYouTubeImportError(e);
                if (d) showAlert(d.title, d.message);
            }
        }
    }, [input]);

    // A link handed over by a share or the Feed (a fresh nonce per hand-over,
    // so the same link shared twice starts again).
    useEffect(() => {
        if (!urlParam) return;
        setInput(urlParam);
        const key = `${nonce}:${urlParam}`;
        if (autoStart && lastAutoRef.current !== key) {
            lastAutoRef.current = key;
            start(urlParam);
        }
    // `start` closes over `input`, which this effect is about to replace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [urlParam, autoStart, nonce]);

    // The saved episode's transcription, once the import is done.
    const episodeId = job?.episode?.id;
    useEffect(() => { setTranscript(null); }, [episodeId]);
    useEffect(() => onLibraryChange((p) => {
        if (!episodeId || p?.episodeId !== episodeId) return;
        if (p.type === 'transcript-progress') setTranscript({ percent: p.percent || 0 });
        else if (p.type === 'transcript-complete') setTranscript('done');
        else if (p.type === 'transcript-error') setTranscript('error');
    }), [episodeId]);

    const paste = useCallback(async () => {
        try {
            const text = (await Clipboard.getStringAsync()) || '';
            if (text.trim()) setInput(text.trim());
            else showAlert('Clipboard is empty', 'Copy a YouTube link first.');
        } catch (e) {
            showAlert('Could not read the clipboard', e?.message || 'Please paste the link by hand.');
        }
    }, []);

    const openPlayer = useCallback(async () => {
        if (!job?.episode) return;
        const fresh = await getEpisodeById(job.episode.id).catch(() => null);
        navigation.navigate('Player', { episode: fresh || job.episode });
    }, [navigation, job?.episode]);

    const another = useCallback(() => {
        clearYouTubeImport();
        setInput('');
    }, []);

    const retry = useCallback(() => {
        const url = job?.url || input;
        clearYouTubeImport();
        start(url);
    }, [job?.url, input, start]);

    const transcriptLine = useMemo(() => {
        if (!episodeId) return '';
        if (transcript === 'done' || job?.episode?.has_transcript) return 'Transcript ready.';
        if (transcript === 'error') return 'The transcription failed — the Feed row has a Transcribe pill to retry.';
        if (activeId === episodeId) return `Transcribing on the device${transcript?.percent ? ` · ${Math.round(transcript.percent)}%` : '…'}`;
        if (queuedIds.includes(episodeId)) return 'Waiting for the transcription queue…';
        return 'Transcription queued — its progress shows here and on the episode row.';
    }, [episodeId, transcript, activeId, queuedIds, job?.episode?.has_transcript]);

    if (!isYouTubeImportSupported()) {
        return (
            <View style={[styles.container, styles.centered]}>
                <Text style={styles.intro}>Importing from YouTube is only available on Android.</Text>
            </View>
        );
    }

    const video = job?.video;
    const stageLabel = job?.stage === 'resolving' ? 'Reading the video page…'
        : job?.stage === 'saving' ? 'Adding to My Podcasts…'
        : job?.stage === 'downloading'
            ? `Downloading audio${job.total > 0 ? ` · ${Math.round((job.progress || 0) * 100)}% · ${formatMb(job.downloaded)} of ${formatMb(job.total)}` : job.downloaded > 0 ? ` · ${formatMb(job.downloaded)}` : '…'}`
            : '';

    return (
        <ScrollView
            style={styles.container}
            contentContainerStyle={[styles.content, { paddingBottom: bottom + 32 }]}
            keyboardShouldPersistTaps="handled"
        >
            <Text style={styles.intro}>
                Paste a link to a YouTube video. Podink downloads its audio, files it under the channel in My Podcasts and transcribes it on this device — then it plays like any episode: read along, look words up, save vocabulary.
            </Text>

            <View style={[styles.inputRow, active && styles.inputRowDisabled]}>
                <Icon name="link" size={16} color={colors.textMuted} />
                <TextInput
                    value={input}
                    onChangeText={setInput}
                    placeholder="https://www.youtube.com/watch?v=…"
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    returnKeyType="go"
                    onSubmitEditing={() => { if (valid && !active) start(); }}
                    editable={!active}
                    style={styles.input}
                    accessibilityLabel="YouTube link"
                />
                {input ? (
                    <TouchableOpacity onPress={() => setInput('')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} disabled={active} accessibilityLabel="Clear">
                        <Icon name="x-circle" size={18} color={colors.textMuted} />
                    </TouchableOpacity>
                ) : (
                    <TouchableOpacity onPress={paste} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} disabled={active} accessibilityLabel="Paste">
                        <Icon name="clipboard" size={18} color={colors.accent} />
                    </TouchableOpacity>
                )}
            </View>
            {!!input.trim() && !valid && (
                <Text style={styles.warn}>This does not look like a link to a YouTube video.</Text>
            )}

            <TouchableOpacity
                style={[styles.btn, styles.btnPrimary, (!valid || active) && styles.btnDisabled]}
                disabled={!valid || active}
                onPress={() => start()}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Import audio and transcribe"
            >
                <Icon name="download-cloud" size={18} color={colors.onAccent} />
                <Text style={[styles.btnText, { color: colors.onAccent }]}>Import audio & transcribe</Text>
            </TouchableOpacity>

            {job && (
                <View style={[styles.card, job.stage === 'error' && styles.cardError]}>
                    <View style={styles.cardHead}>
                        {video?.thumbnail ? (
                            <Image source={artworkSource(video.thumbnail)} style={styles.thumb} resizeMode="cover" />
                        ) : (
                            <View style={[styles.thumb, styles.thumbPlaceholder]}>
                                <Icon name="youtube" size={26} color={colors.textFaint} />
                            </View>
                        )}
                        <View style={{ flex: 1, gap: 3 }}>
                            <Text style={styles.cardTitle} numberOfLines={3}>{video?.title || 'YouTube video'}</Text>
                            <Text style={styles.cardMeta} numberOfLines={2}>
                                {[video?.uploaderName, video?.durationSec > 0 ? formatDuration(video.durationSec) : null]
                                    .filter(Boolean).join(' · ')}
                            </Text>
                        </View>
                    </View>

                    {active && (
                        <View style={styles.progressWrap}>
                            <View style={styles.stageRow}>
                                {job.stage !== 'downloading' && <ActivityIndicator size="small" color={colors.accent} />}
                                <Text style={styles.stageText} numberOfLines={2}>{stageLabel}</Text>
                            </View>
                            {job.stage === 'downloading' && (
                                <View style={styles.progressTrack}>
                                    <View style={[styles.progressFill, { width: `${Math.max(1, Math.round((job.progress || 0) * 100))}%` }]} />
                                </View>
                            )}
                            {job.stream?.format && job.stage === 'downloading' && (
                                <Text style={styles.streamText}>
                                    {`${job.stream.format.toUpperCase()}${job.stream.bitrate > 0 ? ` · ${Math.round(job.stream.bitrate / 1000)} kbps` : ''}`}
                                </Text>
                            )}
                            <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={cancelYouTubeImport} activeOpacity={0.8} accessibilityRole="button">
                                <Icon name="x" size={16} color={colors.danger} />
                                <Text style={[styles.btnText, { color: colors.danger }]}>Cancel</Text>
                            </TouchableOpacity>
                        </View>
                    )}

                    {job.stage === 'done' && (
                        <View style={styles.progressWrap}>
                            <View style={styles.stageRow}>
                                <Icon name="check-circle" size={16} color={colors.success} />
                                <Text style={styles.stageText}>
                                    {job.already ? 'Already in your library.' : `Added to My Podcasts under ${job.episode?.podcast_title || 'the channel'}.`}
                                </Text>
                            </View>
                            {!!transcriptLine && (
                                <View style={styles.stageRow}>
                                    <Icon name="align-left" size={16} color={colors.textMuted} />
                                    <Text style={styles.subText}>{transcriptLine}</Text>
                                </View>
                            )}
                            <View style={styles.actions}>
                                <TouchableOpacity style={[styles.btn, styles.btnPrimary, { flex: 1 }]} onPress={openPlayer} activeOpacity={0.8} accessibilityRole="button">
                                    <Icon name="play" size={16} color={colors.onAccent} />
                                    <Text style={[styles.btnText, { color: colors.onAccent }]}>Open in Player</Text>
                                </TouchableOpacity>
                                <TouchableOpacity style={[styles.btn, styles.btnAccent, { flex: 1 }]} onPress={another} activeOpacity={0.8} accessibilityRole="button">
                                    <Icon name="plus" size={16} color={colors.accent} />
                                    <Text style={[styles.btnText, { color: colors.accent }]}>Import another</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    )}

                    {job.stage === 'error' && (
                        <View style={styles.progressWrap}>
                            <Text style={styles.errorTitle}>{job.error?.title || 'Import failed'}</Text>
                            <Text style={styles.errorText}>{job.error?.message || 'Please try again.'}</Text>
                            <View style={styles.actions}>
                                <TouchableOpacity style={[styles.btn, styles.btnAccent, { flex: 1 }]} onPress={retry} activeOpacity={0.8} accessibilityRole="button">
                                    <Icon name="refresh-cw" size={16} color={colors.accent} />
                                    <Text style={[styles.btnText, { color: colors.accent }]}>Try again</Text>
                                </TouchableOpacity>
                                <TouchableOpacity style={[styles.btn, styles.btnMuted, { flex: 1 }]} onPress={another} activeOpacity={0.8} accessibilityRole="button">
                                    <Text style={[styles.btnText, { color: colors.textSecondary }]}>Dismiss</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    )}
                </View>
            )}

            <View style={styles.tip}>
                <Icon name="share-2" size={14} color={colors.textMuted} style={{ marginTop: 2 }} />
                <Text style={styles.tipText}>
                    Faster: in the YouTube app, tap Share on a video and choose Podink — the import starts on its own. Videos are kept until you delete them (swipe in the Library); they are not part of the weekly clean-up.
                </Text>
            </View>
        </ScrollView>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    centered: { alignItems: 'center', justifyContent: 'center', padding: 24 },
    content: { paddingHorizontal: 20, paddingTop: 12, gap: 14 },
    intro: { ...type.body, fontSize: 14, lineHeight: 21, color: colors.textSecondary },
    inputRow: {
        flexDirection: 'row', alignItems: 'center', gap: 10,
        backgroundColor: colors.surfaceElevated, borderRadius: radii.m,
        borderWidth: 0.5, borderColor: colors.hairlineStrong,
        paddingHorizontal: 14, minHeight: 50,
    },
    inputRowDisabled: { opacity: 0.6 },
    input: { flex: 1, ...type.body, fontSize: 15, color: colors.textPrimary, paddingVertical: 12 },
    warn: { ...type.body, color: colors.warning, marginTop: -6 },
    btn: {
        minHeight: 48, borderRadius: radii.m,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
        paddingHorizontal: 14,
    },
    btnPrimary: { backgroundColor: colors.accent },
    btnAccent: { backgroundColor: withAlpha(colors.accent, 0.12), borderWidth: 0.5, borderColor: withAlpha(colors.accent, 0.35) },
    btnGhost: { backgroundColor: withAlpha(colors.danger, 0.10), borderWidth: 0.5, borderColor: withAlpha(colors.danger, 0.3) },
    btnMuted: { backgroundColor: colors.surfaceHigh },
    btnDisabled: { opacity: 0.4 },
    btnText: { ...type.title, fontSize: 15 },
    card: {
        marginTop: 6, padding: 16, gap: 14,
        backgroundColor: colors.surfaceElevated, borderRadius: radii.l,
        borderWidth: 0.5, borderColor: withAlpha(colors.accent, 0.35),
    },
    cardError: { borderColor: withAlpha(colors.danger, 0.4) },
    cardHead: { flexDirection: 'row', gap: 14, alignItems: 'flex-start' },
    thumb: { width: 128, height: 72, borderRadius: radii.s, backgroundColor: colors.surfaceHigh },
    thumbPlaceholder: { alignItems: 'center', justifyContent: 'center' },
    cardTitle: { ...type.title, color: colors.textPrimary, lineHeight: 20 },
    cardMeta: { ...type.body, color: colors.textSecondary },
    progressWrap: { gap: 10 },
    stageRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    stageText: { ...type.bodyStrong, color: colors.textPrimary, flex: 1, lineHeight: 18 },
    subText: { ...type.body, color: colors.textSecondary, flex: 1, lineHeight: 18 },
    streamText: { ...type.caption, color: colors.textMuted },
    progressTrack: { height: 6, borderRadius: 3, backgroundColor: withAlpha(colors.accent, 0.18), overflow: 'hidden' },
    progressFill: { height: '100%', borderRadius: 3, backgroundColor: colors.accent },
    actions: { flexDirection: 'row', gap: 10 },
    errorTitle: { ...type.title, color: colors.danger },
    errorText: { ...type.body, fontSize: 14, lineHeight: 20, color: colors.textSecondary },
    tip: { flexDirection: 'row', gap: 8, paddingTop: 4 },
    tipText: { ...type.body, color: colors.textMuted, lineHeight: 18, flex: 1 },
});

export default YouTubeImportScreen;
