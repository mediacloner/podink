/**
 * Notification service — log-only stub.
 *
 * Real push/local notifications require expo-notifications, which is not
 * installed. This module intentionally does NOT interrupt the user (no
 * Alert.alert): events are recorded in the debug log only, so the trigger
 * logic stays verifiable without hijacking the UI.
 *
 * TO MAKE REAL:
 *   1. yarn add expo-notifications
 *   2. Replace the three functions below with real implementations
 *      (requestPermissionsAsync, scheduleNotificationAsync,
 *      addNotificationResponseReceivedListener).
 *   3. Call initNotifications() once at app startup (e.g. in App.js useEffect).
 */

import { log } from './logService';

// ─── Permission / init ────────────────────────────────────────────────────────

export const initNotifications = async () => {
    log('SYSTEM', 'notificationService: init (log-only stub)');
    return true;
};

// ─── New episodes notification ────────────────────────────────────────────────

/**
 * Record that new episodes are available after a refresh.
 *
 * @param {Array<{ title: string, newCount: number }>} updatedPodcasts
 *   Podcasts that gained at least one new episode this refresh cycle.
 */
export const notifyNewEpisodes = async (updatedPodcasts) => {
    if (!updatedPodcasts || updatedPodcasts.length === 0) return;

    const totalNew = updatedPodcasts.reduce((s, p) => s + p.newCount, 0);
    const body = updatedPodcasts.length === 1
        ? `${updatedPodcasts[0].newCount} new episode${updatedPodcasts[0].newCount > 1 ? 's' : ''} from "${updatedPodcasts[0].title}"`
        : `${totalNew} new episodes from ${updatedPodcasts.length} podcasts`;

    log('SYSTEM', 'New episodes available', { body, totalNew });
};

// ─── Notification tap handler ─────────────────────────────────────────────────

/**
 * Subscribe to notification taps. Log-only stub: nothing to subscribe to.
 * Returns an unsubscribe function.
 */
export const onNotificationTap = (_navigationRef) => {
    return () => {};
};
