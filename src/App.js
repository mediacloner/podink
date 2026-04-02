import React, { useEffect } from 'react';
import { View, LogBox, StyleSheet } from 'react-native';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather as Icon } from '@expo/vector-icons';

import { initDB } from './database/db';
import { setupPlayer } from './services/trackPlayer';

import SubscribedTimeline from './screens/SubscribedTimeline';
import DownloadedTimeline from './screens/DownloadedTimeline';
import PlayerScreen from './screens/PlayerScreen';
import SettingsScreen from './screens/SettingsScreen';
import PodcastsScreen from './screens/PodcastsScreen';
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
        background: '#0C0C0E',
        card:       '#0C0C0E',
        border:     'rgba(255,255,255,0.07)',
        text:       '#FFFFFF',
    },
};

// TabNavigator receives `navigation` from the Stack so we can pass it to
// MiniPlayer, which uses blur/focus events to hide when Player is on screen.
const TabNavigator = ({ navigation }) => {
    const { bottom } = useSafeAreaInsets();
    const tabBarHeight = 72 + bottom;

    return (
        <View style={{ flex: 1 }}>
            <Tab.Navigator
                screenOptions={({ route }) => ({
                    headerStyle:         { backgroundColor: '#0C0C0E' },
                    headerTintColor:     '#fff',
                    headerTitleStyle:    { fontWeight: '700', fontSize: 17, letterSpacing: -0.3 },
                    headerShadowVisible: false,
                    tabBarStyle: {
                        backgroundColor: '#0C0C0E',
                        borderTopWidth:  StyleSheet.hairlineWidth,
                        borderTopColor:  'rgba(255,255,255,0.12)',
                        height:          tabBarHeight,
                        paddingBottom:   bottom + 10,
                        paddingTop:      6,
                    },
                    tabBarLabelStyle:        { fontSize: 10, fontWeight: '600' },
                    tabBarActiveTintColor:   '#4FACFE',
                    tabBarInactiveTintColor: '#636366',
                    tabBarIcon: ({ color, size }) => (
                        <Icon name={TAB_ICONS[route.name] || 'circle'} size={size} color={color} />
                    ),
                })}
            >
                <Tab.Screen name="Timeline" component={SubscribedTimeline} options={{ title: 'Discover' }} />
                <Tab.Screen name="Podcasts" component={PodcastsScreen}     options={{ title: 'My Podcasts' }} />
                <Tab.Screen name="Library"  component={DownloadedTimeline}  options={{ title: 'Library' }} />
                <Tab.Screen name="Settings" component={SettingsScreen} />
            </Tab.Navigator>

            {/* MiniPlayer floats above the tab bar.
                stackNavigation lets it detect when Player is shown/dismissed. */}
            <MiniPlayer bottomOffset={tabBarHeight} stackNavigation={navigation} />
        </View>
    );
};

const App = () => {
    useEffect(() => {
        initDB().then(() => console.log('Database Initialized'));
        setupPlayer().then(() => console.log('Track Player Ready'));
    }, []);

    return (
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
            </Stack.Navigator>
        </NavigationContainer>
    );
};

export default App;
