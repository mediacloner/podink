/**
 * MOCK notification service — uses Alert.alert to simulate notifications
 * so the trigger logic can be verified before installing expo-notifications.
 *
 * TO MAKE REAL:
 *   1. npm install expo-notifications
 *   2. Replace the three mock functions below with the real implementations
 *      shown in the comments above each one.
 *   3. Call initNotifications() once at app startup (e.g. in App.js useEffect).
 */

import { Alert } from 'react-native';

// ─── Permission / init ────────────────────────────────────────────────────────

/**
 * Request notification permissions and configure the channel (Android).
 * Call once at app startup.
 *
 * REAL VERSION:
 *   import * as Notifications from 'expo-notifications';
 *
 *   Notifications.setNotificationHandler({
 *     handleNotification: async () => ({
 *       shouldShowAlert: true,
 *       shouldPlaySound: false,
 *       shouldSetBadge: true,
 *     }),
 *   });
 *
 *   export const initNotifications = async () => {
 *     const { status } = await Notifications.requestPermissionsAsync();
 *     if (status !== 'granted') return false;
 *     if (Platform.OS === 'android') {
 *       await Notifications.setNotificationChannelAsync('new-episodes', {
 *         name: 'New Episodes',
 *         importance: Notifications.AndroidImportance.DEFAULT,
 *       });
 *     }
 *     return true;
 *   };
 */
export const initNotifications = async () => {
    // MOCK: nothing to init
    console.log('[NotificationService] mock init — permissions would be requested here');
    return true;
};

// ─── New episodes notification ────────────────────────────────────────────────

/**
 * Notify the user that new episodes are available after a refresh.
 *
 * @param {Array<{ title: string, newCount: number }>} updatedPodcasts
 *   Podcasts that gained at least one new episode this refresh cycle.
 *
 * REAL VERSION:
 *   export const notifyNewEpisodes = async (updatedPodcasts) => {
 *     if (updatedPodcasts.length === 0) return;
 *
 *     const totalNew = updatedPodcasts.reduce((s, p) => s + p.newCount, 0);
 *     const body = updatedPodcasts.length === 1
 *       ? `${updatedPodcasts[0].newCount} new episode${updatedPodcasts[0].newCount > 1 ? 's' : ''} from ${updatedPodcasts[0].title}`
 *       : `${totalNew} new episodes from ${updatedPodcasts.length} podcasts`;
 *
 *     await Notifications.scheduleNotificationAsync({
 *       content: {
 *         title: 'New episodes available',
 *         body,
 *         sound: false,
 *         badge: totalNew,
 *         data: { screen: 'Podcasts' },   // used in tap handler to navigate
 *       },
 *       trigger: null,  // null = deliver immediately
 *     });
 *   };
 */
export const notifyNewEpisodes = async (updatedPodcasts) => {
    if (updatedPodcasts.length === 0) return;

    const totalNew = updatedPodcasts.reduce((s, p) => s + p.newCount, 0);
    const body = updatedPodcasts.length === 1
        ? `${updatedPodcasts[0].newCount} new episode${updatedPodcasts[0].newCount > 1 ? 's' : ''} from "${updatedPodcasts[0].title}"`
        : `${totalNew} new episodes from ${updatedPodcasts.length} podcasts`;

    // MOCK: show an Alert instead of a real notification
    Alert.alert('New episodes available', body, [{ text: 'OK' }]);
};

// ─── Notification tap handler ─────────────────────────────────────────────────

/**
 * Subscribe to notification taps so the app navigates to the right screen.
 * Returns an unsubscribe function — call it on app unmount.
 *
 * REAL VERSION:
 *   export const onNotificationTap = (navigationRef) => {
 *     const sub = Notifications.addNotificationResponseReceivedListener(response => {
 *       const screen = response.notification.request.content.data?.screen;
 *       if (screen && navigationRef.current) {
 *         navigationRef.current.navigate(screen);
 *       }
 *     });
 *     return () => sub.remove();
 *   };
 */
export const onNotificationTap = (_navigationRef) => {
    // MOCK: nothing to subscribe to
    return () => {};
};
