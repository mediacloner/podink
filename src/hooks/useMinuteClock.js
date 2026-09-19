import { useEffect, useState } from 'react';

/**
 * The current time, re-read on every minute boundary while `active` (a
 * focused screen) — for the station clocks ("14:32 in London") and the
 * "min left" figures of the Live Radio screens, which change on the minute
 * and never in between. Returns epoch milliseconds; the first value is now.
 */
export const useMinuteClock = (active = true) => {
    const [nowMs, setNowMs] = useState(() => Date.now());
    useEffect(() => {
        if (!active) return undefined;
        let t = null;
        const arm = () => {
            t = setTimeout(() => { setNowMs(Date.now()); arm(); }, 60000 - (Date.now() % 60000) + 50);
        };
        setNowMs(Date.now());
        arm();
        return () => clearTimeout(t);
    }, [active]);
    return nowMs;
};
