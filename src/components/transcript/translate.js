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

const BASE = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en';

// Plain text translation — resolves a single string.
export const fetchTranslation = async (text, lang, signal) => {
    const res = await fetch(
        `${BASE}&tl=${encodeURIComponent(lang)}&dt=t&q=${encodeURIComponent(text)}`,
        { signal },
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    return (d?.[0] || []).map(c => c?.[0] ?? '').join('');
};

// Translation + dictionary senses (dt=bd) for a single word.
// Response shape: d[0] = translation chunks, d[1] = [[pos, [terms...], ...], ...]
export const fetchWordInfo = async (word, lang, signal) => {
    const res = await fetch(
        `${BASE}&tl=${encodeURIComponent(lang)}&dt=t&dt=bd&q=${encodeURIComponent(word)}`,
        { signal },
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    const translation = (d?.[0] || []).map(c => c?.[0] ?? '').join('');
    const senses = (Array.isArray(d?.[1]) ? d[1] : [])
        .map(e => ({
            pos: typeof e?.[0] === 'string' ? e[0] : '',
            terms: (Array.isArray(e?.[1]) ? e[1] : []).filter(t => typeof t === 'string').slice(0, 5),
        }))
        .filter(s => s.terms.length > 0);
    return { translation, senses };
};
