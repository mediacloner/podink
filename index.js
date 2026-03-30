import { registerRootComponent } from 'expo';
import TrackPlayer from 'react-native-track-player';
import App from './src/App';

// MUST be registered before registerRootComponent so the native
// player finds the JS event handler during initialisation.
TrackPlayer.registerPlaybackService(() => require('./src/services/playbackService').default);

registerRootComponent(App);
