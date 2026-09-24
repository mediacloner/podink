/**
 * "Skip ad" over the bottom of the transcript while playback is inside one of
 * the advertisements the assistant found (aiService.snapAds, getEpisodeAds).
 * A tap jumps to where the episode resumes. It only offers: an ad the model
 * placed wrong costs a glance, never a stretch of the episode.
 *
 * Its own component so the half-second position ticks re-render this button,
 * not the Player.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import { useProgress } from 'react-native-track-player';
import { Feather as Icon } from '@expo/vector-icons';
import { radii, useStyles, useTheme } from '../../theme';

// 0:45, 1:30 — the time an ad has left.
const mmss = (ms) => {
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const SkipAdButton = ({ ads, onSkip }) => {
    const { colors } = useTheme();
    const st = useStyles(makeStyles);
    const { position } = useProgress(500);
    const ms = position * 1000;
    // Not in the last second, so a skip that lands a hair early does not
    // bring the button straight back.
    const ad = ads?.find(a => ms >= a.start_ms && ms < a.end_ms - 1000);
    if (!ad) return null;
    const left = Math.max(0, ad.end_ms - ms);
    return (
        <TouchableOpacity
            style={st.btn}
            onPress={() => onSkip(ad.end_ms)}
            activeOpacity={0.85}
            accessibilityRole='button'
            accessibilityLabel={`Skip advertisement${ad.label ? ` for ${ad.label}` : ''}, ${Math.round(left / 1000)} seconds`}
        >
            <Text style={st.label} numberOfLines={1}>Skip ad · {mmss(left)}</Text>
            <Icon name='skip-forward' size={15} color={colors.onAccent} />
        </TouchableOpacity>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    btn: {
        position: 'absolute', right: 16, bottom: 16,
        flexDirection: 'row', alignItems: 'center', gap: 8,
        paddingVertical: 10, paddingHorizontal: 16, borderRadius: radii.pill,
        backgroundColor: colors.accent,
        elevation: 4, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
    },
    label: { color: colors.onAccent, fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
});

export default SkipAdButton;
