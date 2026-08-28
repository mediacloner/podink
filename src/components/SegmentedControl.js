import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { radii, type, useStyles, withAlpha } from '../theme';

// Compact filter switch — a row of equal segments, one selected. Same visual
// language as the Settings chips (surface track, accent-tinted selection).
// options: [{ id, label }], value: selected id, onChange(id).
const SegmentedControl = ({ options, value, onChange, style }) => {
    const styles = useStyles(makeStyles);
    return (
        <View style={[styles.track, style]} accessibilityRole="tablist">
            {options.map(({ id, label }) => {
                const selected = id === value;
                return (
                    <TouchableOpacity
                        key={id}
                        style={[styles.segment, selected && styles.segmentOn]}
                        onPress={() => onChange(id)}
                        activeOpacity={0.7}
                        accessibilityRole="tab"
                        accessibilityLabel={label}
                        accessibilityState={{ selected }}
                    >
                        <Text style={[styles.label, selected && styles.labelOn]} numberOfLines={1}>
                            {label}
                        </Text>
                    </TouchableOpacity>
                );
            })}
        </View>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    track: {
        flexDirection: 'row',
        backgroundColor: colors.surface,
        borderRadius: radii.s,
        borderWidth: 0.5,
        borderColor: colors.hairline,
        padding: 3,
    },
    segment: {
        flex: 1,
        minHeight: 34,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.s - 3,
    },
    segmentOn: { backgroundColor: withAlpha(colors.accent, 0.14) },
    label: { ...type.label, color: colors.textSecondary },
    labelOn: { color: colors.accent, fontWeight: '700' },
});

export default SegmentedControl;
