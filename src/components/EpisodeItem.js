import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather as Icon } from '@expo/vector-icons';
import Animated, {
    FadeInDown, FadeOut, useAnimatedStyle, useSharedValue, withSpring,
} from 'react-native-reanimated';
import Pill from './Pill';
import { type, useStyles, useTheme } from '../theme';
import { onTranscriptProgress, getLastProgress } from '../services/whisperService';

// "1h 23m" / "45 min" / "<1 min". Whole minutes throughout, so 1h 59m 40s
// reads "2h" rather than "1h 60m".
export const formatDuration = (seconds) => {
    const minutes = Math.round((seconds || 0) / 60);
    if (minutes < 1) return '<1 min';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
    return `${minutes} min`;
};

const EpisodeItem = ({
    episode,
    onPress,
    onDownload,
    onTranscribe,
    onCancel,
    onDelete,
    isTranscribing,
    isDownloading,
    downloadProgress,
    isQueued,
    cardStyle,
    // Feed variant: podcast cover on the left, and tapping the row expands
    // the description (with an explicit Play button) instead of navigating.
    showArtwork = false,
    expandOnPress = false,
    // Continue Listening variant: no download/transcribe column — the row
    // exists to be resumed, so a single play glyph stands in for the pills.
    hideActions = false,
}) => {
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const [expanded, setExpanded] = useState(false);
    // Per-row transcription progress: subscribing here means a 1% tick
    // re-renders this row only, never the whole screen.
    const [progress, setProgress] = useState(0);
    const rotation = useSharedValue(0);

    useEffect(() => {
        if (!isTranscribing) {
            setProgress(0);
            return undefined;
        }
        // Seed from the service: progress events only arrive once per decoded
        // window, so a row mounting mid-job would otherwise show "Processing…"
        // until the next event.
        setProgress(getLastProgress(episode.id));
        const unsub = onTranscriptProgress?.((e) => {
            if (e && String(e.episodeId) === String(episode.id) && typeof e.percent === 'number') {
                setProgress(e.percent);
            }
        });
        return () => unsub?.();
    }, [isTranscribing, episode.id]);

    const toggleExpand = () => {
        const next = !expanded;
        setExpanded(next);
        rotation.value = withSpring(next ? 1 : 0, { damping: 15 });
    };

    const chevronStyle = useAnimatedStyle(() => ({
        transform: [{ rotate: `${rotation.value * 180}deg` }],
    }));

    const formattedDate = new Date(episode.release_date).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    });

    // Total length (from the feed, or stored by the player once it has run)
    // and where a started-but-unfinished listen stands. Completion resets
    // play_position to 0, so a position > 0 always means "in progress".
    const durationSec = episode.duration > 0 ? episode.duration : 0;
    const inProgress = !episode.is_played && episode.play_position > 0;
    const durationLabel = durationSec > 0 ? formatDuration(durationSec) : '';
    const progressFraction = inProgress && durationSec > 0
        ? Math.min(1, episode.play_position / durationSec)
        : 0;
    const progressLabel = !inProgress ? ''
        : durationSec > 0 ? `${formatDuration(Math.max(0, durationSec - episode.play_position))} left`
        : 'In progress';

    return (
        <View style={[styles.card, cardStyle]}>
            {/* Main row: tap = open player, or expand the description when
                expandOnPress (Feed) — playback then goes through the Play pill */}
            <TouchableOpacity
                onPress={expandOnPress ? toggleExpand : () => onPress(episode)}
                activeOpacity={0.7}
                style={styles.row}
                accessibilityRole="button"
                accessibilityLabel={(expandOnPress
                    ? `${expanded ? 'Hide' : 'Show'} details for ${episode.title}`
                    : `Open ${episode.title}`)
                    + (durationLabel ? `, ${durationLabel}` : '')
                    + (episode.is_played ? ', played' : progressLabel ? `, ${progressLabel}` : '')}
                accessibilityState={expandOnPress ? { expanded } : undefined}
            >
                {showArtwork && (
                    episode.image_url ? (
                        <Image source={{ uri: episode.image_url }} style={styles.artwork} />
                    ) : (
                        <View style={[styles.artwork, styles.artworkPlaceholder]}>
                            <Icon name="headphones" size={18} color={colors.textFaint} />
                        </View>
                    )
                )}

                {/* Left info — plain View, tap bubbles up to outer row */}
                <View style={styles.info}>
                    <Text style={styles.podcastLabel} numberOfLines={1}>
                        {episode.podcast_title}
                    </Text>
                    <Text
                        style={[styles.episodeTitle, !!episode.is_played && styles.episodeTitlePlayed]}
                        numberOfLines={2}
                    >
                        {episode.title}
                    </Text>
                    {/* Visual only — the row's accessibilityLabel carries the
                        length and played / in-progress state for screen readers */}
                    <View style={styles.metaRow}>
                        <Text style={styles.date}>{formattedDate}</Text>
                        {!!durationLabel && (
                            <>
                                <Text style={styles.metaDot}>·</Text>
                                <Text style={styles.duration}>{durationLabel}</Text>
                            </>
                        )}
                        {episode.is_played ? (
                            <>
                                <Text style={styles.metaDot}>·</Text>
                                <View style={styles.stateTag}>
                                    <Icon name="check-circle" size={11} color={colors.success} />
                                    <Text style={styles.playedText}>Played</Text>
                                </View>
                            </>
                        ) : inProgress ? (
                            <>
                                <Text style={styles.metaDot}>·</Text>
                                <View style={styles.stateTag}>
                                    <Icon name="play" size={10} color={colors.accent} />
                                    <Text style={styles.progressText}>{progressLabel}</Text>
                                </View>
                            </>
                        ) : null}
                    </View>
                    {progressFraction > 0 && (
                        <View style={styles.progressTrack}>
                            <View style={[styles.progressFill, { width: `${Math.max(2, progressFraction * 100)}%` }]} />
                        </View>
                    )}
                </View>

                {/* Right: action pills intercept their own touches */}
                {hideActions ? (
                    <View style={styles.resumeCol} pointerEvents="none">
                        <Icon name="play-circle" size={24} color={colors.accent} />
                    </View>
                ) : (
                <View style={styles.right} collapsable={false}>
                    {!episode.is_downloaded ? (
                        <Pill
                            variant="blue"
                            icon="arrow-down-circle"
                            label={isDownloading
                                ? (downloadProgress > 0 ? `${Math.round(downloadProgress)}%` : '…')
                                : 'Download'}
                            onPress={() => onDownload?.(episode)}
                            disabled={isDownloading}
                            loading={isDownloading}
                            accessibilityLabel={isDownloading ? 'Downloading episode' : 'Download episode'}
                        />
                    ) : (
                        <View style={styles.downloadedCol}>
                            <Pill
                                variant="green"
                                icon="check"
                                label="Downloaded"
                                accessibilityLabel="Episode downloaded"
                            />

                            <View style={styles.actionRow}>
                                {isTranscribing ? (
                                    <Pill
                                        variant="orange"
                                        icon="x"
                                        label={progress > 0 ? `${Math.min(100, Math.round(progress))}%` : 'Processing…'}
                                        trailingLoading
                                        onPress={() => onCancel?.(episode)}
                                        accessibilityLabel="Cancel transcription"
                                    />
                                ) : isQueued && !episode.has_transcript ? (
                                    <Pill
                                        variant="orange"
                                        icon="clock"
                                        label="Queued"
                                        onPress={() => onCancel?.(episode)}
                                        accessibilityLabel="Remove from transcription queue"
                                    />
                                ) : onTranscribe && !episode.has_transcript ? (
                                    <Pill
                                        variant="blue"
                                        solid
                                        icon="zap"
                                        label="Transcribe"
                                        onPress={() => onTranscribe(episode)}
                                        accessibilityLabel="Transcribe episode"
                                    />
                                ) : episode.has_transcript ? (
                                    <Pill
                                        variant="blue"
                                        bordered={false}
                                        icon="align-left"
                                        label="Transcript"
                                        accessibilityLabel="Transcript available"
                                    />
                                ) : null}

                                {onDelete && (
                                    <TouchableOpacity
                                        style={styles.iconBtn}
                                        onPress={() => onDelete(episode)}
                                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                        accessibilityRole="button"
                                        accessibilityLabel="Delete episode"
                                    >
                                        <Icon name="trash-2" size={15} color={colors.textFaint} />
                                    </TouchableOpacity>
                                )}
                            </View>
                        </View>
                    )}
                </View>
                )}
            </TouchableOpacity>

            {/* Bottom strip. With expandOnPress the whole row is the toggle, so
                the strip is a purely visual affordance (no second tab stop);
                otherwise it's the tap target (hitSlop -> 44px). */}
            {expandOnPress ? (
                <View
                    style={[styles.expandStrip, expanded && styles.expandStripOpen]}
                    pointerEvents="none"
                    accessible={false}
                    importantForAccessibility="no-hide-descendants"
                >
                    <Animated.View style={chevronStyle}>
                        <Icon name="chevron-down" size={15} color={colors.textFaint} />
                    </Animated.View>
                </View>
            ) : (
                <TouchableOpacity
                    onPress={toggleExpand}
                    style={[styles.expandStrip, expanded && styles.expandStripOpen]}
                    activeOpacity={0.6}
                    hitSlop={{ top: 10, bottom: 10 }}
                    accessibilityRole="button"
                    accessibilityLabel={expanded ? 'Collapse episode description' : 'Expand episode description'}
                    accessibilityState={{ expanded }}
                >
                    <Animated.View style={chevronStyle}>
                        <Icon name="chevron-down" size={15} color={colors.textFaint} />
                    </Animated.View>
                </TouchableOpacity>
            )}

            {/* Expanded description */}
            {expanded && (
                <Animated.View
                    entering={FadeInDown.duration(200)}
                    exiting={FadeOut.duration(150)}
                    style={styles.description}
                >
                    <Text style={styles.descriptionText}>
                        {episode.description?.replace(/<[^>]+>/g, '') || 'No description available.'}
                    </Text>
                    {expandOnPress && (
                        <Pill
                            variant="blue"
                            solid
                            icon="play"
                            // In-progress beats played: a finished episode's
                            // position resets to 0, so position > 0 means a
                            // re-listen is underway and the tap will resume.
                            label={episode.play_position > 0
                                ? 'Resume'
                                : (episode.is_played ? 'Play again' : 'Play')}
                            onPress={() => onPress(episode)}
                            style={styles.playPill}
                        />
                    )}
                </Animated.View>
            )}
        </View>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    card: {
        borderBottomWidth: 0.5,
        borderBottomColor: colors.hairlineFaint,
        backgroundColor: colors.bg,
    },
    row: {
        flexDirection: 'row',
        paddingHorizontal: 20,
        paddingTop: 16,
        paddingBottom: 10,
        gap: 14,
    },

    /* Artwork (Feed rows) — same spec as the search-result thumbnails */
    artwork: {
        width: 44,
        height: 44,
        borderRadius: 8,
        backgroundColor: colors.surfaceElevated,
    },
    artworkPlaceholder: {
        alignItems: 'center',
        justifyContent: 'center',
    },

    /* Info */
    info: { flex: 1, gap: 4 },
    podcastLabel: {
        ...type.caption,
        fontWeight: '700',
        color: colors.textMuted,
        textTransform: 'uppercase',
    },
    episodeTitle: {
        ...type.title,
        color: colors.textPrimary,
        lineHeight: 21,
    },
    episodeTitlePlayed: { color: colors.textSecondary },
    // Wraps on narrow screens so the state tag drops to its own line instead
    // of pushing the date out of the column.
    metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: 6, rowGap: 2 },
    date: { ...type.label, fontWeight: '400', color: colors.textMuted },
    metaDot: { ...type.label, color: colors.textFaint },
    duration: { ...type.label, fontWeight: '400', color: colors.textMuted },
    stateTag: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    playedText: { ...type.label, color: colors.success },
    progressText: { ...type.label, color: colors.accent },
    progressTrack: {
        height: 3,
        borderRadius: 1.5,
        backgroundColor: colors.hairlineStrong,
        overflow: 'hidden',
        marginTop: 2,
    },
    progressFill: { height: '100%', borderRadius: 1.5, backgroundColor: colors.accent },

    /* Right column */
    right: { alignItems: 'flex-end', justifyContent: 'center', minWidth: 90 },
    resumeCol: { justifyContent: 'center', paddingLeft: 4 },
    downloadedCol: { alignItems: 'flex-end', gap: 8 },
    actionRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },

    iconBtn: {
        width: 28,
        height: 28,
        alignItems: 'center',
        justifyContent: 'center',
    },

    /* Bottom expand strip */
    expandStrip: {
        alignItems: 'center',
        justifyContent: 'center',
        height: 24,
    },
    expandStripOpen: {
        borderTopWidth: 0.5,
        borderTopColor: colors.hairlineFaint,
    },

    /* Description */
    description: { paddingHorizontal: 20, paddingBottom: 16 },
    descriptionText: { ...type.body, color: colors.textSecondary, lineHeight: 20 },
    playPill: { alignSelf: 'flex-start', marginTop: 12 },
});

export default React.memo(EpisodeItem);
