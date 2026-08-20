// English dictionary definitions from the Free Dictionary API
// (https://dictionaryapi.dev — Wiktionary data, no key required).

const BASE = 'https://api.dictionaryapi.dev/api/v2/entries/en/';

const MAX_MEANINGS = 4;
const MAX_DEFS_PER_MEANING = 3;

const parseEntries = (data) => {
    const entries = Array.isArray(data) ? data : [];
    const phonetic = entries
        .map(e => e?.phonetic || (e?.phonetics || []).find(p => p?.text)?.text)
        .find(Boolean) || '';
    const audioUrls = entries
        .flatMap(e => (Array.isArray(e?.phonetics) ? e.phonetics : []))
        .map(p => p?.audio)
        .filter(a => typeof a === 'string' && a.startsWith('https://'));
    // Prefer British/American recordings over other accents (-au etc.),
    // falling back to whatever the entry has.
    const audioUrl = audioUrls.find(a => a.endsWith('-uk.mp3'))
        || audioUrls.find(a => a.endsWith('-us.mp3'))
        || audioUrls[0]
        || '';
    const meanings = entries
        .flatMap(e => (Array.isArray(e?.meanings) ? e.meanings : []))
        .map(m => ({
            pos: typeof m?.partOfSpeech === 'string' ? m.partOfSpeech : '',
            definitions: (Array.isArray(m?.definitions) ? m.definitions : [])
                .filter(d => typeof d?.definition === 'string' && d.definition)
                .slice(0, MAX_DEFS_PER_MEANING)
                .map(d => ({
                    definition: d.definition,
                    example: typeof d?.example === 'string' ? d.example : '',
                })),
        }))
        .filter(m => m.definitions.length > 0)
        .slice(0, MAX_MEANINGS);
    return { phonetic, audioUrl, meanings };
};

// Transcript words are often inflected ("speakers", "host's"); on a miss,
// retry with the possessive/plural tail stripped before giving up.
const candidatesFor = (word) => {
    const w = (word || '').toLowerCase();
    const list = [w];
    const noPossessive = w.replace(/['’]s$/, '');
    if (noPossessive !== w) list.push(noPossessive);
    if (noPossessive.length > 3 && noPossessive.endsWith('s')) {
        list.push(noPossessive.slice(0, -1));
    }
    return [...new Set(list)].filter(Boolean);
};

// Resolves { phonetic, meanings: [{ pos, definitions: [{ definition, example }] }] }.
// A word simply missing from the dictionary resolves to empty meanings.
// The API sporadically 5xxes on individual forms, so a server error on one
// candidate falls through to the next; it only rejects if every candidate
// errored with nothing found.
export const fetchDefinitions = async (word, signal) => {
    let lastError = null;
    for (const candidate of candidatesFor(word)) {
        try {
            const res = await fetch(BASE + encodeURIComponent(candidate), { signal });
            if (res.status === 404) continue;
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const parsed = parseEntries(await res.json());
            if (parsed.meanings.length) return parsed;
        } catch (e) {
            if (e?.name === 'AbortError') throw e;
            lastError = e;
        }
    }
    if (lastError) throw lastError;
    return { phonetic: '', audioUrl: '', meanings: [] };
};
