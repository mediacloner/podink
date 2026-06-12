import React, { useCallback, useEffect, useState } from 'react';
import { View, LogBox, StyleSheet, ActivityIndicator } from 'react-native';
import { NavigationContainer, DarkTheme, useIsFocused } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather as Icon } from '@expo/vector-icons';

import { initDB } from './database/db';
import AppAlert from './components/AppAlert';
import { setupPlayer, onUserPlay, onUserStop } from './services/trackPlayer';
import { restoreQueue, initializeWhisper } from './services/whisperService';
import { cleanupOldWhisperModels } from './services/downloadService';
import { restoreLogs } from './services/logService';
import { getTotalNewEpisodesCount } from './database/queries';
import { onLibraryChange } from './services/libraryEvents';
import { colors, type } from './theme';

import SubscribedTimeline from './screens/SubscribedTimeline';
import DownloadedTimeline from './screens/DownloadedTimeline';
import PlayerScreen from './screens/PlayerScreen';
import SettingsScreen from './screens/SettingsScreen';
import PodcastsScreen from './screens/PodcastsScreen';
import LogScreen from './screens/LogScreen';
import VocabularyScreen from './screens/VocabularyScreen';
import MiniPlayer from './components/MiniPlayer';

LogBox.ignoreLogs(['Attempted to import the module']);

const Stack = createNativeStackNavigator();
const Tab   = createBottomTabNavigator();

const TAB_ICONS = {
    Timeline: 'rss',
    Podcasts: 'headphones',
    Library:  'archive',
    Settings: 'sliders',
};

const appTheme = {
    ...DarkTheme,
    colors: {
        ...DarkTheme.colors,
        primary:    colors.accent,
        background: colors.bg,
        card:       colors.bg,
        border:     colors.hairline,
        text:       colors.textPrimary,
    },
};

// Badge types that can change the new-episodes count; transcript events can't.
const BADGE_EVENT_TYPES = ['subscribe', 'unsubscribe', 'download-complete', 'episode-delete'];

const PodcastsTabIcon = ({ color, size }) => {
    const [hasNew, setHasNew] = useState(false);
    const isFocused = useIsFocused();

    const check = useCallback(async () => {
        try {
            const count = await getTotalNewEpisodesCount();
            setHasNew(count > 0);
        } catch (_) {}
    }, []);

    // Event-driven instead of polling: re-check on library changes that can
    // affect the count, and whenever this tab gains/loses focus (collapse on
    // blur marks episodes as seen).
    useEffect(() => { check(); }, [isFocused, check]);
    useEffect(() => onLibraryChange((payload) => {
        const t = payload?.type;
        if (t === undefined || BADGE_EVENT_TYPES.includes(t)) check();
    }), [check]);

    return (
        <View>
            <Icon name="headphones" size={size} color={color} />
            {hasNew && <View style={styles.dot} />}
        </View>
    );
};

// TabNavigator receives `navigation` from the Stack so we can pass it to
// MiniPlayer, which uses blur/focus events to hide when Player is on screen.
const TabNavigator = ({ navigation }) => {
    const { bottom } = useSafeAreaInsets();
    const tabBarHeight = 72 + bottom;

    // Only mount MiniPlayer after the user explicitly plays a podcast.
    // Conditional mounting (not just hiding) is the only reliable fix —
    // an always-mounted but "hidden" view still renders on Android with
    // elevation, causing it to appear in the wrong position at startup.
    const [showMiniPlayer, setShowMiniPlayer] = useState(false);
    useEffect(() => onUserPlay(() => setShowMiniPlayer(true)), []);
    useEffect(() => onUserStop(() => setShowMiniPlayer(false)), []);

    return (
        <View style={{ flex: 1 }}>
            <Tab.Navigator
                screenOptions={({ route }) => ({
                    headerStyle:         { backgroundColor: colors.bg },
                    headerTintColor:     colors.textPrimary,
                    headerTitleStyle:    { ...type.heading },
                    headerShadowVisible: false,
                    tabBarStyle: {
                        backgroundColor: colors.bg,
                        borderTopWidth:  StyleSheet.hairlineWidth,
                        borderTopColor:  colors.hairlineStrong,
                        height:          tabBarHeight,
                        paddingBottom:   bottom + 10,
                        paddingTop:      6,
                    },
                    tabBarLabelStyle:        { fontSize: 10, fontWeight: '600' },
                    tabBarActiveTintColor:   colors.accent,
                    tabBarInactiveTintColor: colors.textMuted,
                    tabBarIcon: ({ color, size }) => (
                        <Icon name={TAB_ICONS[route.name] || 'circle'} size={size} color={color} />
                    ),
                })}
            >
                <Tab.Screen name="Timeline" component={SubscribedTimeline} options={{ title: 'Feed' }} />
                <Tab.Screen
                    name="Podcasts"
                    component={PodcastsScreen}
                    options={{
                        title: 'My Podcasts',
                        tabBarIcon: ({ color, size }) => <PodcastsTabIcon color={color} size={size} />,
                    }}
                />
                <Tab.Screen name="Library"  component={DownloadedTimeline}  options={{ title: 'Library' }} />
                <Tab.Screen name="Settings" component={SettingsScreen} />
            </Tab.Navigator>

            {showMiniPlayer && (
                <MiniPlayer bottomOffset={tabBarHeight} stackNavigation={navigation} />
            )}
        </View>
    );
};

const App = () => {
    // Screens query SQLite on mount; don't render them until migrations finish.
    const [dbReady, setDbReady] = useState(false);

    useEffect(() => {
        restoreLogs();
        initDB()
            .then(() => {
                console.log('Database Initialized');
                restoreQueue();
                cleanupOldWhisperModels();
                // Pre-warm STT model so the first transcription doesn't pay cold-start.
                initializeWhisper();
            })
            .catch((e) => console.error('DB init failed', e))
            .finally(() => setDbReady(true));
        setupPlayer().then(() => console.log('Track Player Ready'));
    }, []);

    if (!dbReady) {
        return (
            <View style={styles.bootSplash}>
                <ActivityIndicator size="large" color={colors.accent} />
            </View>
        );
    }

    return (
        <SafeAreaProvider>
            <AppAlert />
            <NavigationContainer theme={appTheme}>
                <Stack.Navigator screenOptions={{ headerShown: false }}>
                    <Stack.Screen
                        name="MainTabs"
                        component={TabNavigator}
                    />
                    <Stack.Screen
                        name="Player"
                        component={PlayerScreen}
                        options={{
                            animation:        'slide_from_bottom',
                            gestureEnabled:   true,
                            gestureDirection: 'vertical',
                        }}
                    />
                    <Stack.Screen
                        name="Vocabulary"
                        component={VocabularyScreen}
                        options={{ headerShown: true }}
                    />
                    <Stack.Screen
                        name="DebugLog"
                        component={LogScreen}
                        options={{ headerShown: true }}
                    />
                </Stack.Navigator>
            </NavigationContainer>
        </SafeAreaProvider>
    );
};

const styles = StyleSheet.create({
    bootSplash: {
        flex:            1,
        backgroundColor: colors.bg,
        alignItems:      'center',
        justifyContent:  'center',
    },
    dot: {
        position:        'absolute',
        top:             0,
        right:           -2,
        width:           7,
        height:          7,
        borderRadius:    3.5,
        backgroundColor: colors.danger,
    },
});

export default App;
