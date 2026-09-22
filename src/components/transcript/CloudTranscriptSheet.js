/**
 * The cloud transcript, and what to do with it.
 *
 * The phone transcribes every episode itself, and that is the text the app
 * reads. When a recording defeats it — a noisy line, an hour of unfamiliar
 * names — this is the way out: the audio goes to a recogniser in the cloud
 * for about ten cents an hour, on the listener's own key, and what comes
 * back can be read beside the phone's before anything is decided. Only
 * *Use this text* replaces the episode's own (queries.promoteMaiTranscript),
 * and the cloud copy is kept afterwards, since it was paid for.
 *
 * The sheet owns the run; the Player owns the transcript and is told to
 * refresh through `onChanged`.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather as Icon } from '@expo/vector-icons';
import { radii, useStyles, useTheme, withAlpha } from '../../theme';
import SheetModal from './SheetModal';
import { showAlert } from '../AppAlert';
import { deleteMaiTranscript, promoteMaiTranscript } from '../../database/queries';
import { cancelMaiTest, estimateMaiCost, isMaiTesting, testMaiTranscription } from '../../services/maiTranscriptionService';
import { indexEpisodeNames } from '../../services/nameIndex';

const words = (rows) => (rows || []).reduce((n, r) => n + String(r.text || '').trim().split(/\s+/).filter(Boolean).length, 0);
const thousands = (n) => n.toLocaleString('en-US');
const day = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');

const CloudTranscriptSheet = ({
    visible, onClose, episode, localSegments = [], mai = { run: null, segments: [] },
    viewCloud = false, onViewCloud = () => {}, onChanged = () => {},
}) => {
    const { colors } = useTheme();
    const st = useStyles(makeStyles);
    const epId = episode?.id;

    const [running, setRunning] = useState(false);
    const [percent, setPercent] = useState(0);
    const [busy, setBusy] = useState('');        // 'use' | 'delete'
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!visible) return;
        setError(null);
        setRunning(isMaiTesting(epId));
    }, [visible, epId]);

    const localWords = useMemo(() => words(localSegments), [localSegments]);
    const cloudWords = useMemo(() => words(mai.segments), [mai.segments]);
    const hasCloud = cloudWords > 0;
    const isCloudText = episode?.transcript_source === 'cloud';
    const estimate = estimateMaiCost(episode?.duration || 0);

    const transcribe = useCallback(() => {
        if (!episode?.local_audio_path || running) return;
        showAlert(
            'Transcribe in the cloud',
            `This sends the audio of “${episode.title}” to OpenRouter. It should cost about $${estimate.toFixed(2)}, and the text you have now is kept until you replace it yourself.`,
            [
                { text: 'Not now', style: 'cancel' },
                { text: 'Transcribe', onPress: async () => {
                    setError(null);
                    setRunning(true);
                    setPercent(0);
                    try {
                        await testMaiTranscription(episode, setPercent);
                        onChanged();
                    } catch (e) {
                        if (e?.message !== 'MAI test cancelled') setError(e?.message || 'The cloud transcription failed.');
                    } finally {
                        setRunning(false);
                    }
                } },
            ]
        );
    }, [episode, running, estimate, onChanged]);

    const use = useCallback(() => {
        if (!hasCloud || busy) return;
        showAlert(
            'Use the cloud text',
            'This becomes the episode’s transcript. The summary, chapters, corrections and the books it names are cleared, and written again from the new text when you ask for them. The phone’s own transcript goes — it can be made again for nothing.',
            [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Use this text', onPress: async () => {
                    setError(null);
                    setBusy('use');
                    try {
                        const rows = await promoteMaiTranscript(epId);
                        onViewCloud(false);
                        indexEpisodeNames(epId, { force: true }).catch(() => {});
                        onChanged();
                        showAlert('The cloud text is this episode’s transcript', `${thousands(rows)} lines, timed as they were spoken.`);
                        onClose();
                    } catch (e) {
                        setError(e?.message || 'The transcript could not be replaced.');
                    } finally {
                        setBusy('');
                    }
                } },
            ]
        );
    }, [hasCloud, busy, epId, onViewCloud, onChanged, onClose]);

    const discard = useCallback(() => {
        if (!hasCloud || busy) return;
        showAlert('Delete the cloud copy', 'Transcribing it again would cost what it cost the first time.', [
            { text: 'Keep it', style: 'cancel' },
            { text: 'Delete', style: 'destructive', onPress: async () => {
                setBusy('delete');
                try {
                    await deleteMaiTranscript(epId);
                    onViewCloud(false);
                    onChanged();
                } catch (e) {
                    setError(e?.message || 'The cloud copy could not be deleted.');
                } finally {
                    setBusy('');
                }
            } },
        ]);
    }, [hasCloud, busy, epId, onViewCloud, onChanged]);

    const header = (
        <View style={st.labelRow}>
            <Icon name='cloud' size={13} color={colors.textMuted} />
            <Text style={st.label}>Cloud transcription</Text>
        </View>
    );

    const source = (which) => {
        const cloud = which === 'cloud';
        const reading = cloud ? viewCloud : !viewCloud;
        const count = cloud ? cloudWords : localWords;
        return (
            <TouchableOpacity
                style={[st.sourceRow, reading && st.sourceRowOn]}
                onPress={() => onViewCloud(cloud)}
                disabled={!hasCloud || !localSegments.length}
                activeOpacity={0.7}
                accessibilityRole='radio'
                accessibilityState={{ selected: reading }}
                accessibilityLabel={cloud ? 'Read the cloud text' : 'Read the phone’s text'}
            >
                <Icon
                    name={cloud ? 'cloud' : 'smartphone'}
                    size={16}
                    color={reading ? colors.accent : colors.textMuted}
                />
                <View style={{ flex: 1 }}>
                    <Text style={[st.sourceName, reading && st.sourceNameOn]}>
                        {cloud ? 'Cloud transcript' : (isCloudText ? 'This episode’s transcript' : 'The phone’s transcript')}
                    </Text>
                    <Text style={st.sourceMeta}>
                        {count ? `${thousands(count)} words` : 'none yet'}
                        {cloud && mai.run?.created_at ? ` · ${day(mai.run.created_at)}` : ''}
                        {cloud && mai.run?.cost_usd ? ` · $${Number(mai.run.cost_usd).toFixed(2)}` : ''}
                        {!cloud && isCloudText ? ' · from the cloud' : ''}
                    </Text>
                </View>
                {reading && <Icon name='check' size={16} color={colors.accent} />}
            </TouchableOpacity>
        );
    };

    return (
        <SheetModal visible={visible} onClose={onClose} header={header} maxHeight='80%'>
            {!!error && (
                <View style={st.errorBox}>
                    <Icon name='alert-circle' size={14} color={colors.danger} style={{ marginTop: 2 }} />
                    <Text style={st.errorText}>{error}</Text>
                </View>
            )}

            <View style={st.sourceList}>
                {source('local')}
                {hasCloud && source('cloud')}
            </View>

            {running ? (
                <View style={{ gap: 12, marginTop: 18 }}>
                    <View style={st.progressTrack}>
                        <View style={[st.progressFill, { width: `${Math.max(3, percent)}%` }]} />
                    </View>
                    <View style={st.runningRow}>
                        <ActivityIndicator size='small' color={colors.accent} />
                        <Text style={st.runningText}>Transcribing in the cloud… {percent}%</Text>
                        <TouchableOpacity onPress={() => cancelMaiTest(epId)} accessibilityRole='button'>
                            <Text style={st.dangerLink}>Stop</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            ) : hasCloud ? (
                <View style={{ gap: 14, marginTop: 18 }}>
                    <Text style={st.body}>
                        Read both above, then keep the one that reads better. Replacing clears the summary, chapters and corrections so they are written again from the new text.
                    </Text>
                    <TouchableOpacity
                        style={[st.primaryBtn, !!busy && st.btnBusy]}
                        onPress={use}
                        disabled={!!busy}
                        activeOpacity={0.85}
                        accessibilityRole='button'
                        accessibilityLabel='Use the cloud text as this episode’s transcript'
                    >
                        {busy === 'use' && <ActivityIndicator size='small' color={colors.onAccent} />}
                        <Icon name='check-circle' size={16} color={colors.onAccent} />
                        <Text style={st.primaryText}>Use this text</Text>
                    </TouchableOpacity>
                    <View style={st.linkRow}>
                        <TouchableOpacity onPress={transcribe} disabled={!!busy} accessibilityRole='button'>
                            <Text style={st.link}>Transcribe again</Text>
                        </TouchableOpacity>
                        <View style={{ flex: 1 }} />
                        <TouchableOpacity onPress={discard} disabled={!!busy} accessibilityRole='button'>
                            <Text style={st.dangerLink}>Delete the copy</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            ) : (
                <View style={{ gap: 14, marginTop: 18 }}>
                    <Text style={st.body}>
                        The phone transcribes every episode itself, and that costs nothing. When a recording defeats it — a noisy line, an hour of unfamiliar names — a recogniser in the cloud can do better. The audio is sent to OpenRouter with your own key; the text you have now stays until you choose to replace it.
                    </Text>
                    <TouchableOpacity
                        style={st.primaryBtn}
                        onPress={transcribe}
                        disabled={!episode?.local_audio_path}
                        activeOpacity={0.85}
                        accessibilityRole='button'
                        accessibilityLabel={`Transcribe in the cloud, about $${estimate.toFixed(2)}`}
                    >
                        <Icon name='upload-cloud' size={16} color={colors.onAccent} />
                        <Text style={st.primaryText}>Transcribe in the cloud · about ${estimate.toFixed(2)}</Text>
                    </TouchableOpacity>
                    <Text style={st.caption}>Needs an OpenRouter key — Settings → Cloud transcription test.</Text>
                </View>
            )}
        </SheetModal>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    labelRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
    label: { fontSize: 12, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', color: colors.textMuted },
    body: { fontSize: 15, lineHeight: 22, color: colors.textSecondary },
    caption: { fontSize: 12, lineHeight: 17, color: colors.textMuted },

    sourceList: { borderRadius: radii.m, borderWidth: 0.5, borderColor: colors.hairline, overflow: 'hidden' },
    sourceRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 14 },
    sourceRowOn: { backgroundColor: withAlpha(colors.accent, 0.1) },
    sourceName: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
    sourceNameOn: { color: colors.accent },
    sourceMeta: { fontSize: 12, color: colors.textMuted, marginTop: 2 },

    progressTrack: { height: 6, borderRadius: 3, backgroundColor: withAlpha(colors.accent, 0.15), overflow: 'hidden' },
    progressFill: { height: 6, borderRadius: 3, backgroundColor: colors.accent },
    runningRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    runningText: { flex: 1, fontSize: 14, color: colors.textSecondary },

    primaryBtn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
        paddingVertical: 13, paddingHorizontal: 18, borderRadius: radii.pill, backgroundColor: colors.accent,
    },
    btnBusy: { opacity: 0.7 },
    primaryText: { color: colors.onAccent, fontSize: 15, fontWeight: '700' },

    linkRow: { flexDirection: 'row', alignItems: 'center' },
    link: { color: colors.accent, fontSize: 14, fontWeight: '700' },
    dangerLink: { color: colors.danger, fontSize: 14, fontWeight: '700' },

    errorBox: {
        flexDirection: 'row', gap: 10, padding: 12, marginBottom: 14, borderRadius: radii.m,
        backgroundColor: withAlpha(colors.danger, 0.1), borderWidth: 0.5, borderColor: withAlpha(colors.danger, 0.35),
    },
    errorText: { flex: 1, fontSize: 14, lineHeight: 20, color: colors.textPrimary },
});

export default CloudTranscriptSheet;
