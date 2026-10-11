import React, { useCallback, useEffect, useState } from 'react';
import { Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather as Icon } from '@expo/vector-icons';
import SheetModal from './transcript/SheetModal';
import { showAlert } from './AppAlert';
import { useTranscriptionQueue } from '../hooks/useTranscriptionQueue';
import {
    downloadEpisode, isImportedEpisode, isLocalEpisode, markListened, markUnlistened,
    removeEpisodeDownload, removeEpisodeTranscript, reportDownloadError,
    reportTranscriptionError, transcribeEpisode,
} from '../services/episodeService';
import { dequeueTranscription } from '../services/whisperService';
import { isBookTranscript, needsSync, textDoesNotFit } from '../services/bookService';
import { artworkSource } from '../api/userAgent';
import { log } from '../services/logService';
import { type, useStyles, useTheme } from '../theme';

/**
 * Hold an episode row and everything that can be done with it comes up in
 * one sheet (user, 5.8.1: "when you click in a podcast for a long time open
 * a section, with all options that can do, delete transcription, remove
 * etc") — the swipes, the pills, and what neither offers: an episode in
 * progress goes back to Downloaded (or, streamed, back to the start), as if
 * it had never been played.
 *
 * Mounted once at the root, like AppAlert; a row opens it with
 * showEpisodeActions(episode, ctx). `ctx` is the row's own handlers —
 * onOpen, onDownload, onTranscribe, onCancel, onDelete, onMarkSeen, onSync,
 * onRematch — so an action taken here behaves as it does from the row (a
 * download shows its percent in that list, a Library transcribe its
 * optimistic state). What the row has no handler for runs through
 * episodeService, whose library events reload every list. Also in `ctx`:
 * isDownloading / downloadProgress / isSyncing, and the row's
 * durationLabel / progressLabel for the header.
 *
 * Only what applies to the episode as it stands is listed. No action asks
 * for confirmation, as the swipes don't: holding a row and reading the list
 * is deliberate already, and each line says what it takes with it.
 */
let _show = null;

export const showEpisodeActions = (episode, ctx = {}) => {
    if (!episode) return;
    log('UI', 'Episode actions', { id: episode.id, title: episode.title });
    _show?.(episode, ctx);
};

// A handler from the row returns false (or resolves to it) on a failure it
// has already reported; one that throws gets the alert here.
const attempt = async (what, fn) => {
    try {
        await fn();
    } catch (e) {
        log('UI', 'Episode action failed', { what, error: e?.message || String(e) });
        showAlert(`Could not ${what}`, 'Please try again.');
    }
};

// Groups of actions, in order: listen / get, where it stands, what goes.
const buildGroups = (episode, ctx, { activeId, queuedIds }) => {
    const onDevice = !!episode.is_downloaded && !ctx.isDownloading;
    const inProgress = !episode.is_played && episode.play_position > 0;
    const transcribing = activeId === episode.id;
    const queued = !transcribing && queuedIds.includes(episode.id);
    const book = isBookTranscript(episode);
    // The Downloaded segment lists podcast downloads and YouTube videos, not
    // the chapters of an imported collection (queries.LISTENING_STATE_SQL).
    const backToDownloaded = onDevice && !isLocalEpisode(episode);

    const listen = [];
    if (ctx.onOpen) {
        listen.push({
            key: 'open',
            icon: 'play-circle',
            label: inProgress ? 'Resume' : episode.is_played ? 'Play again' : 'Play',
            run: () => ctx.onOpen(episode),
        });
    }
    if (!episode.is_downloaded && !ctx.isDownloading && !isImportedEpisode(episode) && episode.audio_url) {
        listen.push({
            key: 'download',
            icon: 'arrow-down-circle',
            label: 'Download',
            hint: episode.has_transcript ? undefined : 'The transcript follows on its own',
            run: ctx.onDownload
                ? () => ctx.onDownload(episode)
                : () => downloadEpisode(episode).catch(reportDownloadError),
        });
    }
    if (onDevice && !episode.has_transcript) {
        if (transcribing || queued) {
            listen.push({
                key: 'cancel',
                icon: 'x-circle',
                label: transcribing ? 'Stop transcribing' : 'Take out of the queue',
                // dequeueTranscription keeps the resume marker.
                hint: transcribing ? 'A later try picks up where it stopped' : undefined,
                run: () => (ctx.onCancel ? ctx.onCancel(episode) : dequeueTranscription(episode.id)),
            });
        } else {
            listen.push({
                key: 'transcribe',
                icon: 'zap',
                label: 'Transcribe',
                hint: 'On the phone',
                run: ctx.onTranscribe
                    ? () => ctx.onTranscribe(episode)
                    : () => transcribeEpisode(episode).catch(e => reportTranscriptionError(e, episode)),
            });
        }
    }
    // A chapter reading its book's text: the matching the row's pill offers.
    if (book && !ctx.isSyncing) {
        if (ctx.onSync && needsSync(episode)) {
            listen.push({
                key: 'sync', icon: 'book-open', label: 'Match voice',
                hint: "Times the book text by the narrator's pauses",
                run: () => ctx.onSync(episode),
            });
        } else if (ctx.onRematch && episode.has_transcript && !textDoesNotFit(episode)) {
            listen.push({
                key: 'rematch', icon: 'book-open', label: 'Match the voice again',
                run: () => ctx.onRematch(episode),
            });
        }
    }

    const state = [];
    if (inProgress) {
        state.push({
            key: 'reset',
            icon: 'rotate-ccw',
            label: backToDownloaded ? 'Back to Downloaded' : 'Start over',
            hint: backToDownloaded
                ? 'Forgets where you were, as if never played'
                : 'Forgets where you were, off In progress',
            run: () => attempt('reset the episode', () => markUnlistened(episode)),
        });
    }
    if (episode.is_played) {
        state.push({
            key: 'unplayed',
            icon: 'rotate-ccw',
            label: 'Mark as unplayed',
            hint: backToDownloaded ? 'Back to Downloaded' : 'Back to not started',
            run: () => attempt('update the episode', () => markUnlistened(episode)),
        });
    } else {
        state.push({
            key: 'played',
            icon: 'check-circle',
            label: 'Mark as played',
            hint: 'Moves it to Finished',
            run: () => attempt('update the episode', () => markListened(episode)),
        });
    }
    if (episode.is_new && ctx.onMarkSeen) {
        state.push({
            key: 'seen', icon: 'check', label: 'Clear the new mark',
            run: () => ctx.onMarkSeen(episode),
        });
    }

    const remove = [];
    // A book chapter's text is not a transcript to throw away: it came from
    // the EPUB, and the collection editor is where that changes.
    if (onDevice && episode.has_transcript && !book && !transcribing) {
        remove.push({
            key: 'transcript',
            icon: 'x-circle',
            label: 'Remove transcript',
            hint: 'Keeps the audio; summary, chapters and names go too',
            run: () => attempt('remove the transcript', () => removeEpisodeTranscript(episode)),
        });
    }
    if (onDevice) {
        remove.push({
            key: 'delete',
            icon: 'trash-2',
            label: isImportedEpisode(episode) ? 'Delete' : 'Delete download',
            hint: isImportedEpisode(episode)
                ? 'Takes it out of Podink, file and all'
                : 'Audio and transcript. The episode stays in its feed',
            danger: true,
            run: ctx.onDelete
                ? () => ctx.onDelete(episode)
                : () => attempt('delete it', () => removeEpisodeDownload(episode)),
        });
    }

    return [listen, state, remove].filter(g => g.length > 0);
};

const statusLine = (episode, ctx, { activeId, queuedIds }) => {
    const parts = [];
    const time = ctx.progressLabel || ctx.durationLabel;
    if (time) parts.push(time);
    if (ctx.isDownloading) {
        parts.push(ctx.downloadProgress > 0 ? `Downloading ${Math.round(ctx.downloadProgress)}%` : 'Downloading…');
    } else if (episode.is_downloaded && !isLocalEpisode(episode)) {
        parts.push('Downloaded');
    }
    if (episode.has_transcript) parts.push(isBookTranscript(episode) ? 'Book text' : 'Transcript');
    else if (activeId === episode.id) parts.push('Transcribing');
    else if (queuedIds.includes(episode.id)) parts.push('Queued');
    if (episode.is_played) parts.push('Played');
    return parts.join('  ·  ');
};

const ActionRow = ({ action, onPress }) => {
    const { colors } = useTheme();
    const st = useStyles(makeStyles);
    const tint = action.danger ? colors.danger : colors.accent;
    return (
        <TouchableOpacity
            style={st.action}
            onPress={() => onPress(action)}
            activeOpacity={0.6}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            accessibilityHint={action.hint}
        >
            <Icon name={action.icon} size={19} color={tint} style={st.actionIcon} />
            <View style={st.actionText}>
                <Text style={[st.actionLabel, action.danger && { color: colors.danger }]}>{action.label}</Text>
                {!!action.hint && <Text style={st.actionHint}>{action.hint}</Text>}
            </View>
        </TouchableOpacity>
    );
};

const EpisodeActionsSheet = () => {
    const { colors } = useTheme();
    const st = useStyles(makeStyles);
    const [target, setTarget] = useState(null); // { episode, ctx }
    const [visible, setVisible] = useState(false);
    // Live, so a transcription that starts or ends while the sheet is open
    // changes what it offers.
    const queue = useTranscriptionQueue();

    useEffect(() => {
        const show = (episode, ctx) => {
            setTarget({ episode, ctx });
            setVisible(true);
        };
        _show = show;
        return () => { if (_show === show) _show = null; };
    }, []);

    const close = useCallback(() => setVisible(false), []);

    const handlePress = useCallback((action) => {
        setVisible(false);
        if (!target) return;
        log('UI', 'Episode action', { id: target.episode.id, action: action.key });
        Promise.resolve()
            .then(action.run)
            .catch(e => log('UI', 'Episode action threw', { action: action.key, error: e?.message || String(e) }));
    }, [target]);

    const episode = target?.episode;
    const ctx = target?.ctx || {};
    const groups = episode ? buildGroups(episode, ctx, queue) : [];
    const status = episode ? statusLine(episode, ctx, queue) : '';

    const header = episode ? (
        <View style={st.head}>
            {episode.image_url ? (
                <Image source={artworkSource(episode.image_url)} style={st.artwork} />
            ) : (
                <View style={[st.artwork, st.artworkPlaceholder]}>
                    <Icon name="headphones" size={20} color={colors.textFaint} />
                </View>
            )}
            <View style={st.headText}>
                {!!episode.podcast_title && (
                    <Text style={st.podcast} numberOfLines={1}>{episode.podcast_title}</Text>
                )}
                <Text style={st.title} numberOfLines={3}>{episode.title}</Text>
                {!!status && <Text style={st.status}>{status}</Text>}
            </View>
        </View>
    ) : null;

    return (
        <SheetModal visible={visible} onClose={close} header={header}>
            {groups.map((group, i) => (
                <View key={group[0].key} style={[st.group, i > 0 && st.groupDivided]}>
                    {group.map(action => (
                        <ActionRow key={action.key} action={action} onPress={handlePress} />
                    ))}
                </View>
            ))}
        </SheetModal>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    head: { flexDirection: 'row', gap: 14, marginBottom: 12 },
    artwork: { width: 52, height: 52, borderRadius: 10, backgroundColor: colors.surfaceElevated },
    artworkPlaceholder: { alignItems: 'center', justifyContent: 'center' },
    headText: { flex: 1, gap: 3 },
    podcast: { ...type.caption, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase' },
    title: { ...type.title, fontSize: 16, fontWeight: '700', lineHeight: 21, color: colors.textPrimary },
    status: { ...type.label, fontWeight: '400', color: colors.textMuted },

    group: { paddingVertical: 4 },
    groupDivided: { borderTopWidth: 0.5, borderTopColor: colors.hairline },
    action: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, minHeight: 48 },
    actionIcon: { width: 34 },
    actionText: { flex: 1, gap: 2 },
    actionLabel: { ...type.title, color: colors.textPrimary },
    actionHint: { ...type.body, fontSize: 12, color: colors.textMuted },
});

export default EpisodeActionsSheet;
