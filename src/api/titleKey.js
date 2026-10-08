/**
 * A title as two catalogues should compare it. "CNN+" and "CNN Plus",
 * "Disney+" and "Disney Plus", "Constantine (2005 film)" and "Constantine"
 * are one name; a leading "The", accents, case and punctuation are not part
 * of it. A catalogue search answers with whatever it ranks first, so a hit
 * whose key is not the one asked for is somebody else's title — "Hulu" came
 * back as a 2026 series of that name (5.8.1).
 */
export const titleKey = (s) => String(s || '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ').replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, ' ').trim()
    .replace(/^the /, '');

export const sameTitle = (a, b) => {
    const k = titleKey(a);
    return !!k && k === titleKey(b);
};
