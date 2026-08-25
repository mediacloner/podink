import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather as Icon } from '@expo/vector-icons';
import { colors, radii, withAlpha } from '../../theme';

// Floating "Back to current" pill shown when follow-mode is off and the active
// line has drifted off-center. The chevron points toward the active line.
const FollowPill = ({ direction, onPress }) => (
    <View style={st.wrap} pointerEvents='box-none'>
        <Pressable
            onPress={onPress}
            hitSlop={8}
            style={({ pressed }) => [st.pill, pressed && st.pressed]}
        >
            <Icon
                name={direction === 'down' ? 'chevron-down' : 'chevron-up'}
                size={15}
                color={colors.textPrimary}
            />
            <Text style={st.label}>Back to current</Text>
        </Pressable>
    </View>
);

const st = StyleSheet.create({
    wrap: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 24,
        alignItems: 'center',
    },
    pill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: radii.pill,
        backgroundColor: withAlpha(colors.surfaceElevated, 0.96),
        borderWidth: 0.5,
        borderColor: colors.hairlineStrong,
        shadowColor: 'black',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.35,
        shadowRadius: 10,
        elevation: 8,
    },
    pressed: { opacity: 0.8 },
    label: { color: colors.textPrimary, fontSize: 13, fontWeight: '600' },
});

export default FollowPill;
