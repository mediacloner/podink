import { useEffect, useId } from 'react';
import { AppState } from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { log } from '../services/logService';

/**
 * Keeps the display on while the calling screen is mounted — a transcript is
 * read, not watched, so a page of text with no touches runs into the phone's
 * screen timeout (user, 2026-09-21: "when I'm reading the transcription the
 * screen shut down").
 *
 * expo-keep-awake's own useKeepAwake asks once, on mount, and never looks
 * again, which leaves two ways to end up in the dark:
 *
 *   - the request rejects (no current activity at that moment) and nothing
 *     retries or reports it — the hook doesn't even catch it;
 *   - the flag lives on the Activity window, so an activity the system
 *     recreated in the background comes back without it. Under the new
 *     architecture the JS instance survives that, so the Player is still
 *     mounted and never re-asks — and the native manager, which still holds
 *     the tag, only re-adds the flag while it holds none, so every later
 *     activate() is a no-op.
 *
 * Hence: re-arm whenever the app returns to the foreground, releasing the tag
 * first so a lost flag is really re-applied, and send failures to the debug
 * log instead of an unhandled rejection.
 */
export const useScreenAwake = (active = true) => {
    // One tag per mounted screen: releasing a tag only clears the window flag
    // when it is the last one held, so an overlapping screen can't switch the
    // display off under the one that is still reading.
    const tag = useId();

    useEffect(() => {
        if (!active) return undefined;
        let cancelled = false;

        const arm = async (reason, attempt = 1) => {
            try {
                await deactivateKeepAwake(tag);
                if (cancelled) return;
                await activateKeepAwakeAsync(tag);
            } catch (e) {
                log('SYSTEM', 'Keep awake failed', { reason, attempt, error: String(e?.message || e) });
                // The usual failure is an activity that isn't current yet, a
                // moment that passes — so one retry, rather than reading the
                // rest of an episode against the screen timeout.
                if (attempt === 1) setTimeout(() => { if (!cancelled) arm(reason, 2); }, 800);
            }
        };

        arm('mount');
        const sub = AppState.addEventListener('change', (next) => {
            if (next === 'active') arm('foreground');
        });

        return () => {
            cancelled = true;
            sub.remove();
            deactivateKeepAwake(tag).catch(() => {});
        };
    }, [active, tag]);
};
