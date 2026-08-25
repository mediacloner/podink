// Shared helpers for the unofficial Google Translate endpoint used by the
// transcript translation modal and the word popover.

const LANG_NAMES = {
    es: 'Español',
    fr: 'Français',
    de: 'Deutsch',
    it: 'Italiano',
    pt: 'Português',
    ca: 'Català',
    nl: 'Nederlands',
    pl: 'Polski',
    ru: 'Русский',
    ja: '日本語',
    zh: '中文',
    ko: '한국어',
};

export const langLabel = (code) => LANG_NAMES[code] || (code || '').toUpperCase();

// English names for the same codes — for phrasing a request to an outside
// assistant ("translate to Spanish", not "to Español").
const LANG_ENGLISH = {
    es: 'Spanish',
    fr: 'French',
    de: 'German',
    it: 'Italian',
    pt: 'Portuguese',
    ca: 'Catalan',
    nl: 'Dutch',
    pl: 'Polish',
    ru: 'Russian',
    ja: 'Japanese',
    zh: 'Chinese',
    ko: 'Korean',
    en: 'English',
};

export const langEnglishName = (code) => LANG_ENGLISH[code] || (code || '').toUpperCase();

// Same translation backend, two client keys. Google throttles `gtx` hard —
// it answers 429 for a whole IP for minutes at a time — so the Chrome
// built-in-translate client goes first and gtx is only the fallback. Both
// return the identical array shape, so parsing below is shared.
const ENDPOINTS = [
    'https://clients5.google.com/translate_a/single?client=dict-chrome-ex&sl=en',
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en',
];

// Failures carry a `kind` so the UI can tell "this phone has no network" from
// "Google is throttling us" instead of always blaming the connection.
const tagged = (kind, message) => Object.assign(new Error(message), { kind });

// Human-readable reason for a failed translation or lookup. `fallback` covers
// everything that isn't about connectivity (empty result, odd response).
export const translateErrorMessage = (err, fallback = 'Translation failed. Try again.') => {
    if (err?.kind === 'offline') return "Can't reach the translation service. Check your connection.";
    if (err?.kind === 'throttled') return 'Google is rate-limiting translations right now. Try again in a few minutes.';
    return fallback;
};

const requestJson = async (base, query, signal) => {
    let res;
    try {
        res = await fetch(`${base}&${query}`, { signal });
    } catch (e) {
        if (e?.name === 'AbortError') throw e;
        // fetch rejecting, rather than returning a bad status, means the
        // request never left the device: no network, or DNS/TLS failure.
        throw tagged('offline', e?.message || 'Network request failed');
    }
    // A throttled or refused client key is not a dead connection.
    if (res.status === 429 || res.status === 403) throw tagged('throttled', 'HTTP ' + res.status);
    if (!res.ok) throw tagged('server', 'HTTP ' + res.status);
    try {
        return await res.json();
    } catch (e) {
        if (e?.name === 'AbortError') throw e;
        // Throttling sometimes arrives as an HTML "Sorry..." page with a 200.
        throw tagged('throttled', 'Malformed response');
    }
};

// Tries each client key in turn; rejects with the last failure's `kind`.
const request = async (query, signal) => {
    let lastError = tagged('server', 'No translation endpoint reachable');
    for (const base of ENDPOINTS) {
        try {
            return await requestJson(base, query, signal);
        } catch (e) {
            if (e?.name === 'AbortError') throw e;
            lastError = e;
        }
    }
    throw lastError;
};

// Plain text translation — resolves a single string.
export const fetchTranslation = async (text, lang, signal) => {
    const d = await request(
        `tl=${encodeURIComponent(lang)}&dt=t&q=${encodeURIComponent(text)}`,
        signal,
    );
    return (d?.[0] || []).map(c => c?.[0] ?? '').join('');
};

// Translation + dictionary senses (dt=bd) for a single word.
// Response shape: d[0] = translation chunks, d[1] = [[pos, [terms...], ...], ...]
export const fetchWordInfo = async (word, lang, signal) => {
    const d = await request(
        `tl=${encodeURIComponent(lang)}&dt=t&dt=bd&q=${encodeURIComponent(word)}`,
        signal,
    );
    const translation = (d?.[0] || []).map(c => c?.[0] ?? '').join('');
    const senses = (Array.isArray(d?.[1]) ? d[1] : [])
        .map(e => ({
            pos: typeof e?.[0] === 'string' ? e[0] : '',
            terms: (Array.isArray(e?.[1]) ? e[1] : []).filter(t => typeof t === 'string').slice(0, 5),
        }))
        .filter(s => s.terms.length > 0);
    return { translation, senses };
};
