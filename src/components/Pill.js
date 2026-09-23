import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather as Icon } from '@expo/vector-icons';
import { useTheme, useStyles, withAlpha, radii } from '../theme';

const variantColors = (colors) => ({
    blue: colors.accent,
    green: colors.success,
    orange: colors.warning,
    danger: colors.danger,
    neutral: colors.textMuted,
});

// Pill height is ~28px; hitSlop extends pressable pills to a >=44px target.
const PRESS_SLOP = { top: 8, bottom: 8, left: 6, right: 6 };

const Pill = ({
    variant = 'blue',
    solid = false,
    bordered = true,
    // A state rather than an action: no background, no border, no button
    // width. A tinted capsule the same size and shape as the buttons beside
    // it reads as one of them (user, on "Book text" next to "Match": "what
    // is the diference between trancribe match and Book text").
    plain = false,
    icon,
    label,
    onPress,
    disabled = false,
    loading = false,
    trailingLoading = false,
    accessibilityLabel,
    style,
}) => {
    const { colors } = useTheme();
    const VARIANT_COLORS = useStyles(variantColors);
    const tint = VARIANT_COLORS[variant] || VARIANT_COLORS.blue;
    const fg = solid ? colors.onAccent : tint;

    const containerStyle = [
        styles.pill,
        plain
            ? styles.plainPill
            : solid
                ? { backgroundColor: tint }
                : {
                    backgroundColor: withAlpha(tint, 0.10),
                    borderWidth: bordered ? 0.5 : 0,
                    borderColor: withAlpha(tint, 0.25),
                },
        disabled && styles.disabled,
        style,
    ];

    const content = (
        <>
            {loading
                ? <ActivityIndicator size="small" color={fg} style={styles.leadingSpinner} />
                : icon ? <Icon name={icon} size={12} color={fg} /> : null}
            {!!label && (
                <Text style={[styles.label, { color: fg }, solid && styles.labelSolid]} numberOfLines={1}>
                    {label}
                </Text>
            )}
            {trailingLoading && <ActivityIndicator size={10} color={fg} style={styles.trailingSpinner} />}
        </>
    );

    if (onPress) {
        return (
            <TouchableOpacity
                style={containerStyle}
                onPress={onPress}
                disabled={disabled}
                activeOpacity={0.7}
                hitSlop={PRESS_SLOP}
                accessibilityRole="button"
                accessibilityLabel={accessibilityLabel || label}
                accessibilityState={{ disabled }}
            >
                {content}
            </TouchableOpacity>
        );
    }

    return (
        <View
            style={containerStyle}
            accessibilityRole="text"
            accessibilityLabel={accessibilityLabel || label}
        >
            {content}
        </View>
    );
};

const styles = StyleSheet.create({
    pill: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: radii.xl,
        minWidth: 112,
    },
    // A plain pill loses its fill and border, not its footprint: it sits in
    // the same box as the pills above and below it, so "Transcript" under a
    // "Downloaded" pill centres where that label does instead of hugging the
    // column's right edge.
    plainPill: { backgroundColor: 'transparent' },
    label: { fontSize: 12, fontWeight: '600' },
    labelSolid: { fontWeight: '700' },
    disabled: { opacity: 0.45 },
    leadingSpinner: { width: 13 },
    trailingSpinner: { marginLeft: 2 },
});

export default Pill;
