import React, { useCallback } from 'react';
import { FlatList, Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather as Icon } from '@expo/vector-icons';
import { STATIONS } from '../services/radioStations';
import { useRadioSession } from '../services/radioService';
import { radii, type, useStyles, useTheme, withAlpha } from '../theme';

// "Live Radio" tab: the station list. Tapping a station opens its screen
// (programme on air, the next two, Listen / Listen with transcript).
const RadioScreen = ({ navigation }) => {
    const { colors } = useTheme();
    const styles = useStyles(makeStyles);
    const session = useRadioSession();

    const renderItem = useCallback(({ item }) => {
        const active = session?.stationId === item.id;
        return (
            <TouchableOpacity
                style={styles.row}
                activeOpacity={0.7}
                onPress={() => navigation.navigate('RadioStation', { stationId: item.id })}
                accessibilityRole="button"
                accessibilityLabel={`${item.name}, ${item.blurb}`}
            >
                <View style={[styles.logoTile, active && { borderColor: withAlpha(colors.accent, 0.6) }]}>
                    {item.logo
                        ? <Image source={item.logo} style={styles.logo} resizeMode="contain" accessibilityIgnoresInvertColors />
                        : <Text style={styles.flagFallback}>{item.flag}</Text>}
                </View>
                <View style={styles.info}>
                    <View style={styles.titleRow}>
                        <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                        {active && (
                            <View style={styles.livePill}>
                                <View style={styles.liveDot} />
                                <Text style={styles.liveText}>{session.mode === 'transcript' ? 'LIVE · TEXT' : 'LIVE'}</Text>
                            </View>
                        )}
                    </View>
                    <Text style={styles.blurb} numberOfLines={2}>{item.blurb}</Text>
                </View>
                <Icon name="chevron-right" size={18} color={colors.textFaint} />
            </TouchableOpacity>
        );
    }, [session, styles, colors, navigation]);

    return (
        <View style={styles.container}>
            <FlatList
                data={STATIONS}
                keyExtractor={(s) => s.id}
                renderItem={renderItem}
                ItemSeparatorComponent={() => <View style={styles.separator} />}
                ListHeaderComponent={(
                    <Text style={styles.intro}>
                        English-language talk radio, live. Listen straight away, or with a transcript —
                        about 40 seconds behind the air so the words are on screen before you hear them.
                        Rewind, replay, look words up.
                    </Text>
                )}
                contentContainerStyle={{ paddingBottom: 120 }}
            />
        </View>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    intro: { ...type.body, color: colors.textMuted, lineHeight: 19, paddingHorizontal: 20, paddingTop: 6, paddingBottom: 14 },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 20,
        paddingVertical: 14,
        backgroundColor: colors.bg,
        gap: 14,
    },
    // Logos are wordmarks of very different shapes (a wide RTÉ, a round ABC):
    // a wide white tile with `contain` fits them all at a legible size.
    logoTile: {
        width: 96,
        height: 60,
        borderRadius: radii.s,
        backgroundColor: '#FFFFFF',
        borderWidth: 0.5,
        borderColor: colors.hairline,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 8,
    },
    logo: { width: '100%', height: '100%' },
    flagFallback: { fontSize: 28, lineHeight: 34 },
    info: { flex: 1, gap: 3 },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    name: { fontSize: 16, fontWeight: '600', color: colors.textPrimary, flexShrink: 1 },
    blurb: { ...type.body, color: colors.textMuted, lineHeight: 18 },
    livePill: {
        flexDirection: 'row', alignItems: 'center', gap: 5,
        paddingHorizontal: 8, paddingVertical: 3, borderRadius: radii.pill,
        backgroundColor: withAlpha(colors.danger, 0.12),
    },
    liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.danger },
    liveText: { ...type.caption, color: colors.danger },
    separator: { height: 0.5, backgroundColor: withAlpha(colors.textPrimary, 0.06), marginLeft: 130 },
});

export default RadioScreen;
