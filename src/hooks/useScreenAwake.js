import { useEffect, useId } from 'react';
import { AppState, NativeModules, Platform } from 'react-native';

const ScreenAwake = Platform.OS === 'android' ? NativeModules.ScreenAwake : null;

/**
 * Keeps the display on while the calling screen is mounted — a transcript is
 * read, not watched, so a page of text with no touches runs into the phone's
 * screen timeout (user, 2026-09-21: "when I'm reading the transcription the
 * screen shut down"; again 2026-09-28, only off USB — the phone's "stay awake
 * while charging" hides it on the cable).
 *
 * The native ScreenAwake module (ScreenAwakeModule.kt) keeps the holders
 * process-wide and puts the window flag back on every activity as it
 * resumes, so a recreated activity or a release made in the background can't
 * strand it the way expo-keep-awake's tag manager did. Holding again on each
 * return to the foreground is only a belt to those braces: hold is
 * idempotent and re-applies the flag to the current activity.
 */
export const useScreenAwake = (active = true) => {
    // One tag per mounted screen: the flag clears only when no screen holds
    // one, so an overlapping screen can't switch the display off under the
    // one that is still reading.
    const tag = useId();

    useEffect(() => {
        if (!active || !ScreenAwake) return undefined;
        ScreenAwake.hold(tag);
        const sub = AppState.addEventListener('change', (next) => {
            if (next === 'active') ScreenAwake.hold(tag);
        });
        return () => {
            sub.remove();
            ScreenAwake.release(tag);
        };
    }, [active, tag]);
};
