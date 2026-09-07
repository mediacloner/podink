/**
 * shareIntent — text shared *to* the app (4.1.0). Android lists Podink as a
 * share target for text (AndroidManifest: ACTION_SEND text/plain), so a
 * YouTube link can be sent from the YouTube app's Share sheet. The native
 * module (android/…/ShareIntentModule.kt) delivers each share once: the one
 * the app was launched with through getInitialSharedText(), later ones —
 * the app already running, or its activity recreated — as an event.
 * App.js turns a video link into the import screen.
 */
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

const Native = Platform.OS === 'android' ? NativeModules.ShareIntent : null;
const EVENT = 'ShareIntentReceived';

/** The text the app was launched with (a cold-start share), or null. Also
 *  arms the event path, so call it once the app can act on a share. */
export const getInitialSharedText = () => (Native ? Native.getInitialShare() : Promise.resolve(null));

/** fn(text) for every share that arrives while the app is alive. */
export const onSharedText = (fn) => {
    if (!Native) return () => {};
    const emitter = new NativeEventEmitter(Native);
    const sub = emitter.addListener(EVENT, (e) => { if (e?.text) fn(String(e.text)); });
    return () => sub.remove();
};
