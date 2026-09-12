import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, AppState, LogBox, StyleSheet, ActivityIndicator, StatusBar } from 'react-native';
import { NavigationContainer, DarkTheme, DefaultTheme, useIsFocused, useNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Feather as Icon } from '@expo/vector-icons';

import { initDB } from './database/db';
import AppAlert, { showAlert } from './components/AppAlert';
import { setupPlayer, ensurePlayerAlive, onUserPlay, onUserStop } from './services/trackPlayer';
import { restoreQueue } from './services/whisperService';
import { cleanupOldWhisperModels } from './services/downloadService';
import { restoreLogs } from './services/logService';
import { sweepOrphanFiles, sweepStaleFinishedDownloads } from './services/episodeService';
import { sweepRadioSessions } from './services/radioService';
import { backfillBookIndex } from './services/bookIndex';
import { backfillNameIndex } from './services/nameIndex';
import { getInitialSharedText, onSharedText } from './services/shareIntent';
import { isYouTubeUrl } from './services/youtubeService';
import { log } from './services/logService';
import { getTotalNewEpisodesCount } from './database/queries';
import { onLibraryChange } from './services/libraryEvents';
import { ThemeProvider, useTheme, useStyles, type } from './theme';

import SubscribedTimeline from './screens/SubscribedTimeline';
import DownloadedTimeline from './screens/DownloadedTimeline';
import ListeningScreen from './screens/ListeningScreen';
import PlayerScreen from './screens/PlayerScreen';
import SettingsScreen from './screens/SettingsScreen';
import PodcastsScreen from './screens/PodcastsScreen';
import LogScreen from './screens/LogScreen';
import VocabularyScreen from './screens/VocabularyScreen';
import NotebookScreen from './screens/NotebookScreen';
import MiniPlayer from './components/MiniPlayer';
import FinishedEpisodePrompt from './components/FinishedEpisodePrompt';
import SettingsGearButton from './components/SettingsGearButton';
import CollectionScreen from './screens/CollectionScreen';
import CollectionEditorScreen from './screens/CollectionEditorScreen';
import RadioScreen from './screens/RadioScreen';
import RadioStationScreen from './screens/RadioStationScreen';
import YouTubeImportScreen from './screens/YouTubeImportScreen';
import PodcastEpisodesScreen from './screens/PodcastEpisodesScreen';

LogBox.ignoreLogs(['Attempted to import the module']);

const Stack = createNativeStackNavigator();
const Tab   = createBottomTabNavigator();

const TAB_ICONS = {
    Timeline:   'rss',
    Podcasts:   'headphones',
    Library:    'archive',
    Listening:  'play-circle',
    Radio:      'radio',
};

// React Navigation theme derived from the active palette (headers, tab bar
// background, screen background behind transitions).
const useNavigationTheme = () => {
    const { colors, isDark } = useTheme();
    return useMemo(() => {
        const base = isDark ? DarkTheme : DefaultTheme;
        return {
            ...base,
            colors: {
                ...base.colors,
                primary:    colors.accent,
                background: colors.bg,
                card:       colors.bg,
                border:     colors.hairline,
                text:       colors.textPrimary,
            },
        };
    }, [colors, isDark]);
};

// Badge types that can change the new-episodes count; transcript events can't.
const BADGE_EVENT_TYPES = ['subscribe', 'unsubscribe', 'download-complete', 'episode-delete'];

const PodcastsTabIcon = ({ color, size }) => {
    const styles = useStyles(makeStyles);
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
    const { colors } = useTheme();
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
                initialRouteName="Timeline"
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
                        // Symmetric padding so the icon + label group sits in
                        // the middle of the bar above the nav inset.
                        paddingBottom:   bottom + 8,
                        paddingTop:      8,
                    },
                    // v6 bottom-aligns icon + label inside each tab
                    // (justifyContent 'flex-end'), which left a gap above the
                    // icon; centre the pair instead.
                    tabBarItemStyle:         { justifyContent: 'center' },
                    tabBarLabelStyle:        { fontSize: 12, fontWeight: '600', marginTop: 2 },
                    tabBarActiveTintColor:   colors.accent,
                    tabBarInactiveTintColor: colors.textMuted,
                    tabBarIcon: ({ color, size }) => (
                        <Icon name={TAB_ICONS[route.name] || 'circle'} size={size} color={color} />
                    ),
                    // Settings left the tab bar in 2.3.0 — it sits behind a
                    // gear in every tab header (the Feed adds its own copy
                    // next to "+", since setOptions replaces headerRight).
                    // marginTop: the gear's centre sat a touch above the
                    // title's optical centre (x-height); 3 px settles it level.
                    headerRight: () => <SettingsGearButton style={{ marginRight: 16, marginTop: 3 }} />,
                })}
            >
                {/* Live radio (4.0.0): stations, on-air guide, listen with or
                    without a transcript. First tab since 2026-09-07 on the
                    user's ask; the app still opens on the Feed. */}
                <Tab.Screen name="Radio" component={RadioScreen} options={{ title: 'Live Radio' }} />
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
                <Tab.Screen name="Listening" component={ListeningScreen} options={{ title: 'Listening' }} />
            </Tab.Navigator>

            {showMiniPlayer && (
                <MiniPlayer bottomOffset={tabBarHeight} stackNavigation={navigation} />
            )}
        </View>
    );
};

const AppRoot = () => {
    const { colors, isDark } = useTheme();
    const styles = useStyles(makeStyles);
    const navTheme = useNavigationTheme();
    const navRef = useNavigationContainerRef();
    // Screens query SQLite on mount; don't render them until migrations finish.
    const [dbReady, setDbReady] = useState(false);

    // Text shared to the app (4.1.0): a YouTube link opens the import screen
    // and starts the import; anything else gets a hint. Shares that land
    // before the navigator is ready (cold start) wait for onReady.
    const pendingShareRef = useRef(null);
    const openShared = useCallback((text) => {
        const t = String(text || '').trim();
        if (!t) return;
        if (!navRef.isReady()) { pendingShareRef.current = t; return; }
        if (isYouTubeUrl(t)) {
            log('UI', 'Shared link received', { youtube: true });
            navRef.navigate('YouTubeImport', { url: t, autoStart: true, nonce: Date.now() });
        } else {
            log('UI', 'Shared text ignored', { length: t.length });
            showAlert(
                'Not a YouTube link',
                'Podink can import YouTube videos: share one from the YouTube app or a browser. Podcast feeds are added from the Feed tab.',
            );
        }
    }, [navRef]);
    useEffect(() => {
        if (!dbReady) return undefined;
        getInitialSharedText().then(openShared).catch(() => {});
        return onSharedText(openShared);
    }, [dbReady, openShared]);
    const flushPendingShare = useCallback(() => {
        const t = pendingShareRef.current;
        pendingShareRef.current = null;
        if (t) openShared(t);
    }, [openShared]);

    useEffect(() => {
        restoreLogs();
        initDB()
            .then(async () => {
                console.log('Database Initialized');
                // Files no row refers to (.part of a killed download, audio of
                // podcasts unsubscribed by old builds, folders of deleted
                // collections) — before any screen can start a new download.
                await sweepOrphanFiles();
                // Live-radio sessions never outlive the process: rows + files go.
                await sweepRadioSessions();
                restoreQueue();
                cleanupOldWhisperModels();
                // Transcribed episodes never scanned for the books they
                // mention (transcribed before 4.2.0, or scanned offline):
                // one at a time, behind anything the user opens meanwhile.
                // Names the notes spell right, written into transcripts from
                // before 4.5.0 (offline, quick) — ahead of the book scans,
                // which read the corrected text.
                backfillNameIndex().finally(() => backfillBookIndex());
                // Finished downloads that went a week without a replay go
                // (audio + transcript); the rows stay. Also on each resume.
                sweepStaleFinishedDownloads();
            })
            .catch((e) => console.error('DB init failed', e))
            .finally(() => setDbReady(true));
        setupPlayer().then(() => console.log('Track Player Ready'));
    }, []);

    // Android can destroy the track-player service while this JS process stays
    // cached, so resuming from recents leaves every transport command hitting a
    // dead player (play button does nothing). Probe on each resume and rebuild.
    // The same resume is when a cached process notices that days have passed:
    // re-run the finished-download sweep (self-throttled to once an hour).
    useEffect(() => {
        const sub = AppState.addEventListener('change', (next) => {
            if (next === 'active') {
                ensurePlayerAlive();
                if (dbReady) sweepStaleFinishedDownloads();
            }
        });
        return () => sub.remove();
    }, [dbReady]);

    // Status-bar icons follow the palette; the bar itself is transparent
    // (edge-to-edge), so only the icon style matters.
    const statusBar = <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} animated />;

    if (!dbReady) {
        return (
            <View style={styles.bootSplash}>
                {statusBar}
                <ActivityIndicator size="large" color={colors.accent} />
            </View>
        );
    }

    return (
        <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
            {statusBar}
            <AppAlert />
            <FinishedEpisodePrompt />
            <NavigationContainer theme={navTheme} ref={navRef} onReady={flushPendingShare}>
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
                        name="Settings"
                        component={SettingsScreen}
                        options={{ headerShown: true }}
                    />
                    <Stack.Screen
                        name="Vocabulary"
                        component={VocabularyScreen}
                        options={{ headerShown: true }}
                    />
                    {/* Notebook (4.5.0): sentences kept from transcripts with
                        the listener's notes, filed by episode. */}
                    <Stack.Screen
                        name="Notebook"
                        component={NotebookScreen}
                        options={{ headerShown: true }}
                    />
                    {/* Imported audio (3.5.0): a collection's chapter list, and
                        the import / edit form it and My Podcasts open. */}
                    <Stack.Screen
                        name="Collection"
                        component={CollectionScreen}
                        options={{ headerShown: true, title: '' }}
                    />
                    {/* A podcast's whole back catalogue (4.5.1): My Podcasts
                        unfolds a feed to its latest five; "More episodes"
                        under them opens this, the feed read page by page. */}
                    <Stack.Screen
                        name="PodcastEpisodes"
                        component={PodcastEpisodesScreen}
                        options={{ headerShown: true, title: '' }}
                    />
                    <Stack.Screen
                        name="CollectionEditor"
                        component={CollectionEditorScreen}
                        options={{ headerShown: true, title: 'Import audio' }}
                    />
                    <Stack.Screen
                        name="RadioStation"
                        component={RadioStationScreen}
                        options={{ headerShown: true, title: '' }}
                    />
                    {/* YouTube (4.1.0): a video link → downloaded audio +
                        transcript, filed under its channel in My Podcasts.
                        Opened from My Podcasts' folder button, the Feed's add
                        box, or a share from the YouTube app. */}
                    <Stack.Screen
                        name="YouTubeImport"
                        component={YouTubeImportScreen}
                        options={{ headerShown: true, title: 'Import from YouTube' }}
                    />
                    <Stack.Screen
                        name="DebugLog"
                        component={LogScreen}
                        options={{ headerShown: true }}
                    />
                </Stack.Navigator>
            </NavigationContainer>
        </SafeAreaProvider>
        </GestureHandlerRootView>
    );
};

const App = () => (
    <ThemeProvider>
        <AppRoot />
    </ThemeProvider>
);

const makeStyles = (colors) => StyleSheet.create({
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
