import React, { useEffect } from 'react';
import { LogBox } from 'react-native';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

// Services
import { initDB } from './database/db';
import { setupPlayer } from './services/trackPlayer';

// Screens
import SubscribedTimeline from './screens/SubscribedTimeline';
import DownloadedTimeline from './screens/DownloadedTimeline';
import PlayerScreen from './screens/PlayerScreen';
import SettingsScreen from './screens/SettingsScreen';
import PodcastsScreen from './screens/PodcastsScreen';
import { Feather as Icon } from '@expo/vector-icons';

LogBox.ignoreLogs(['Attempted to import the module']);

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

const TabNavigator = () => {
    return (
        <Tab.Navigator
            screenOptions={({ route }) => ({
                headerStyle: { backgroundColor: '#111' },
                headerTintColor: '#fff',
                tabBarStyle: { backgroundColor: '#111', borderTopColor: '#333' },
                tabBarActiveTintColor: '#4a90e2',
                tabBarInactiveTintColor: '#888',
                tabBarIcon: ({ color, size }) => {
                    const icons = {
                        Timeline:  'rss',
                        Podcasts:  'bookmark',
                        Library:   'download',
                        Settings:  'settings',
                    };
                    return <Icon name={icons[route.name] || 'circle'} size={size} color={color} />;
                },
            })}
        >
            <Tab.Screen name="Timeline"  component={SubscribedTimeline} options={{ title: 'Discover' }} />
            <Tab.Screen name="Podcasts"  component={PodcastsScreen}     options={{ title: 'My Podcasts' }} />
            <Tab.Screen name="Library"   component={DownloadedTimeline}  options={{ title: 'Downloads' }} />
            <Tab.Screen name="Settings"  component={SettingsScreen} />
        </Tab.Navigator>
    );
};

const App = () => {
    useEffect(() => {
        // Initialize Core Systems
        initDB().then(() => console.log('Database Initialized'));
        setupPlayer().then(() => console.log('Track Player Ready'));
    }, []);

    return (
        <NavigationContainer theme={DarkTheme}>
            <Stack.Navigator screenOptions={{ presentation: 'modal' }}>
                <Stack.Screen 
                    name="MainTabs" 
                    component={TabNavigator} 
                    options={{ headerShown: false }}
                />
                <Stack.Screen 
                    name="Player" 
                    component={PlayerScreen}
                    options={{ title: 'Now Playing', headerStyle: { backgroundColor: '#111' }, headerTintColor: '#fff' }}
                />
            </Stack.Navigator>
        </NavigationContainer>
    );
};

export default App;
