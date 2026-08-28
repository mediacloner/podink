import React from 'react';
import { TouchableOpacity } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Feather as Icon } from '@expo/vector-icons';
import { useTheme } from '../theme';

// Header gear that opens Settings. Since 2.3.0 Settings is a stack screen,
// not a tab: it is a side door, so the glyph is muted rather than accent.
// Used as the default headerRight of every tab (App.js); the Feed renders it
// itself next to its "+" because setOptions replaces the whole headerRight.
const SettingsGearButton = ({ style }) => {
    const navigation = useNavigation();
    const { colors } = useTheme();
    return (
        <TouchableOpacity
            onPress={() => navigation.navigate('Settings')}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            style={style}
            accessibilityRole="button"
            accessibilityLabel="Open settings"
        >
            <Icon name="settings" size={21} color={colors.textSecondary} />
        </TouchableOpacity>
    );
};

export default SettingsGearButton;
