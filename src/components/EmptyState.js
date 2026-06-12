import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Feather as Icon } from '@expo/vector-icons';
import { colors, type } from '../theme';

const EmptyState = ({ icon, title, subtitle }) => (
    <View style={styles.container}>
        <View style={styles.tile}>
            <Icon name={icon} size={28} color={colors.textFaint} />
        </View>
        <Text style={styles.title}>{title}</Text>
        {!!subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
    </View>
);

const styles = StyleSheet.create({
    container: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 40,
        paddingBottom: 80,
    },
    tile: {
        width: 72,
        height: 72,
        backgroundColor: colors.surface,
        borderRadius: 36,
        borderWidth: 0.5,
        borderColor: colors.hairline,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 20,
    },
    title: {
        ...type.display,
        color: colors.textPrimary,
        marginBottom: 8,
    },
    subtitle: {
        fontSize: 14,
        color: colors.textMuted,
        textAlign: 'center',
        lineHeight: 21,
    },
});

export default EmptyState;
