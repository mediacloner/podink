/**
 * dictionaryService — the offline MDict dictionaries behind the word card.
 *
 * Source of truth is the `dictionaries/` folder of the user's private GitHub
 * repository (mediacloner/penReader — all seventeen `.mdx` sources, the
 * pen carries fifteen of them). A personal access token with read access to
 * that repository, entered once in Settings, lets the app list and download
 * them through the GitHub contents API; nothing is bundled in the APK and
 * no token is baked into the build. The one LFS-tracked file (LDOCE 6,
 * 192 MB) downloads through the pre-signed download_url its metadata names —
 * the contents API itself only serves its 134-byte pointer.
 *
 * On disk: `<documents>/dictionaries/<id>.mdx` next to `<id>.json` — the
 * install record (title, size, style key, entry count) plus the per-block
 * fold index mdx.js needs for lookups (see MdxFile.buildBlockIndex). A
 * dictionary without its .json is treated as not installed (a download
 * that didn't finish indexing is redone).
 *
 * Lookups go through dictionaryLookup.js (the pen's algorithm) on an
 * MdxFile opened lazily and kept open per dictionary.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { Directory, File, Paths } from 'expo-file-system';
import { MdxFile, fileReader } from './mdx';
import { analyzeEntry, lookupEntry, resolveEntry } from './dictionaryLookup';
import { notifyLibraryChange } from './libraryEvents';
import { log } from './logService';

export const GITHUB_TOKEN_KEY = '@github_token';
export const SELECTED_DICTIONARY_KEY = '@dictionary_selected';
const REMOTE_LIST_KEY = '@dictionary_remote_list';

export const DICTIONARY_SOURCE = {
    owner: 'mediacloner',
    repo: 'penReader',
    ref: 'main',
    path: 'dictionaries',
};

const INSTALL_VERSION = 1;

// Display names, style profiles (dictionaryHtml) and picker order — the
// pen's list order, so the two devices agree on what comes first.
const KNOWN = [
    { match: /Oxford English\s*-\s*Spanish/i, short: 'Oxford EN–ES', style: 'oxford-div', order: 0 },
    { match: /Oxford Spanish\s*-\s*English/i, short: 'Oxford ES–EN', style: 'oxford-div', order: 1 },
    { match: /New Oxford American/i, short: 'New Oxford American', style: 'oxford-div', order: 2 },
    { match: /COBUILD Advanced/i, short: 'Collins Advanced', style: 'cobuild', order: 3 },
    { match: /COBUILD Intermediate/i, short: 'Collins Intermediate', style: 'cobuild', order: 4 },
    { match: /Collins English to Spanish/i, short: 'Collins EN–ES', style: 'collins-bilingual', order: 5 },
    { match: /Merriam[\s-]*Webster.s Advanced/i, short: 'MW Advanced', style: 'mw-advanced', order: 6 },
    { match: /Merriam[\s-]*Webster.s English-Spanish/i, short: 'MW EN–ES', style: 'mw-bilingual', order: 7 },
    { match: /Oxford Advanced Learner/i, short: 'Oxford Advanced', style: 'oald', order: 8 },
    { match: /VOX/i, short: 'VOX EN–ES', style: 'vox', order: 9 },
    { match: /Roget/i, short: "Roget's Thesaurus", style: 'plain', order: 10 },
    { match: /Catalana/i, short: 'Gran Diccionari (CA)', style: 'plain', order: 11 },
    // The five later additions the pen carries (penReader revisions 2.9 / 2.20).
    { match: /Merriam[\s-]*Webster.s Collegiate/i, short: 'MW Collegiate 12th', style: 'mw-collegiate', order: 12, title: "Merriam-Webster's Collegiate Dictionary, 12th Edition" },
    { match: /Oxford Dictionary of English/i, short: 'Oxford English', style: 'oxford-english', order: 13 },
    { match: /Collins English Dictionary and Thesaurus/i, short: 'Collins Essential', style: 'collins-essential', order: 14 },
    { match: /longman|LDOCE/i, short: 'Longman LDOCE 6', style: 'ldoce', order: 15, title: 'Longman Dictionary of Contemporary English, 6th edition' },
    { match: /Vocabulary\.com/i, short: 'Vocabulary.com', style: 'vocab', order: 16 },
];

const knownFor = (name) => KNOWN.find(k => k.match.test(name)) || null;

const stripAccents = (s) => { try { return s.normalize('NFD'); } catch (_) { return s; } };

/** File name → stable id: "The New Oxford American Dictionary.mdx" → "the-new-oxford-american-dictionary". */
export const dictionaryId = (fileName) =>
    stripAccents(String(fileName || '').replace(/\.mdx$/i, ''))
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'dictionary';

/** "Collins COBUILD Advanced Learner’s Dictionary (Collins COBUILD…)" → without the series suffix. */
const titleFor = (fileName) => String(fileName || '').replace(/\.mdx$/i, '').replace(/\s*[\(\[][^\)\]]*[\)\]]\s*$/, '').trim();

export const describeDictionary = (fileName) => {
    const known = knownFor(fileName);
    return {
        id: dictionaryId(fileName),
        // `title` overrides for files whose name doesn't read well as one
        // (LDOCE's is snake_case, MW Collegiate's ends in "- Kindle Edition").
        name: known?.title || titleFor(fileName),
        shortName: known?.short || titleFor(fileName).replace(/ Dictionary$/i, ''),
        style: known?.style || 'plain',
        order: known?.order ?? 99,
    };
};

const byOrder = (a, b) => (a.order - b.order) || a.name.localeCompare(b.name);

// ── Storage ──────────────────────────────────────────────────────────────────

const dir = () => new Directory(Paths.document, 'dictionaries');
const ensureDir = () => { const d = dir(); if (!d.exists) d.create({ intermediates: true }); return d; };
const mdxFile = (id) => new File(dir(), `${id}.mdx`);
const metaFile = (id) => new File(dir(), `${id}.json`);

let _installedCache = null;   // [{ id, name, shortName, style, size, entries, installedAt, fileName, path }]
const _open = new Map();      // id → { mdx, meta }

const readMeta = (file) => {
    try { return JSON.parse(file.textSync()); } catch (_) { return null; }
};

/** Installed dictionaries (index records without the block table), picker order. */
export const getInstalledDictionaries = () => {
    if (_installedCache) return _installedCache;
    const out = [];
    try {
        const d = dir();
        if (d.exists) {
            for (const item of d.list()) {
                // Name from the URI: not every expo-file-system version exposes File.name.
                const base = decodeURIComponent(String(item.uri || '').replace(/\/+$/, '').split('/').pop() || '');
                if (!(item instanceof File) || !base.endsWith('.json')) continue;
                const meta = readMeta(item);
                if (!meta || meta.version !== INSTALL_VERSION || !meta.id) continue;
                if (!mdxFile(meta.id).exists) continue;
                const { blocks, ...summary } = meta;
                out.push(summary);
            }
        }
    } catch (e) {
        log('DICT', 'Listing installed dictionaries failed', { error: String(e?.message || e) });
    }
    out.sort(byOrder);
    _installedCache = out;
    return out;
};

export const isDictionaryInstalled = (id) => getInstalledDictionaries().some(d => d.id === id);

const invalidate = () => {
    _installedCache = null;
    notifyLibraryChange({ type: 'dictionaries-changed' });
};

/** Opens (once) the dictionary and its block index. Throws if not installed. */
export const openDictionary = (id) => {
    const cached = _open.get(id);
    if (cached) return cached;
    const meta = readMeta(metaFile(id));
    if (!meta || !meta.blocks) throw new Error(`Dictionary ${id} is not installed`);
    const mdx = MdxFile.open(fileReader(mdxFile(id)), meta.blocks);
    const value = { mdx, meta };
    _open.set(id, value);
    return value;
};

const closeDictionary = (id) => { _open.delete(id); };

// ── Selection ────────────────────────────────────────────────────────────────

/** The dictionary the word card shows: the remembered one if still installed, else the first. */
export const getSelectedDictionaryId = async () => {
    const installed = getInstalledDictionaries();
    if (!installed.length) return null;
    let saved = null;
    try { saved = await AsyncStorage.getItem(SELECTED_DICTIONARY_KEY); } catch (_) {}
    return installed.some(d => d.id === saved) ? saved : installed[0].id;
};

export const setSelectedDictionaryId = async (id) => {
    try { await AsyncStorage.setItem(SELECTED_DICTIONARY_KEY, id); } catch (_) {}
};

// ── Lookup ───────────────────────────────────────────────────────────────────

/**
 * Looks a tapped word up in one dictionary.
 * @param {string} id
 * @param {{word:string, prevWords?:string[], nextWords?:string[], forceWord?:boolean}} query
 * @returns {{ result, flats, highlight, phraseFound, dictionary } | null}
 */
export const lookupWord = (id, query) => {
    const { mdx, meta } = openDictionary(id);
    const found = lookupEntry(mdx, query);
    if (!found) return null;
    const analyzed = analyzeEntry(mdx, found, meta.style);
    return { ...analyzed, dictionary: meta };
};

/** Which installed dictionaries have anything for `word` (exact key or inflection). */
export const probeDictionaries = (word, ids = null) => {
    const list = ids || getInstalledDictionaries().map(d => d.id);
    const out = {};
    for (const id of list) {
        try {
            const { mdx } = openDictionary(id);
            out[id] = !!resolveEntry(mdx, word);
        } catch (_) {
            out[id] = false;
        }
    }
    return out;
};

// ── GitHub ───────────────────────────────────────────────────────────────────

// A token baked into the build, so a fresh install needs no setup: put
// `EXPO_PUBLIC_GITHUB_TOKEN=…` in the gitignored `.env.local` (see
// .env.example) and rebuild — Expo inlines EXPO_PUBLIC_* at bundle time.
// A token saved in Settings overrides it. Never commit a real token.
const BUILT_IN_TOKEN = String(process.env.EXPO_PUBLIC_GITHUB_TOKEN || '').trim();

export const hasBuiltInToken = () => BUILT_IN_TOKEN.length > 0;

/** The token typed into Settings, if any (empty when only the built-in one applies). */
export const getStoredGithubToken = async () => {
    try { return (await AsyncStorage.getItem(GITHUB_TOKEN_KEY)) || ''; } catch (_) { return ''; }
};

/** The token to use: the one saved in Settings, else the one built into the app. */
export const getGithubToken = async () => (await getStoredGithubToken()) || BUILT_IN_TOKEN;

export const setGithubToken = async (token) => {
    const t = String(token || '').trim();
    try {
        if (t) await AsyncStorage.setItem(GITHUB_TOKEN_KEY, t);
        else await AsyncStorage.removeItem(GITHUB_TOKEN_KEY);
    } catch (_) {}
};

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
const contentsUrl = (p) =>
    `https://api.github.com/repos/${DICTIONARY_SOURCE.owner}/${DICTIONARY_SOURCE.repo}/contents/${encodePath(p)}?ref=${encodeURIComponent(DICTIONARY_SOURCE.ref)}`;

const githubHeaders = (token, accept = 'application/vnd.github+json') => ({
    Authorization: `Bearer ${token}`,
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Podink',
});

const githubError = (status) => {
    if (status === 401) return Object.assign(new Error('GitHub rejected the token. Check it in Settings.'), { code: 'AUTH' });
    if (status === 403) return Object.assign(new Error('GitHub refused the request (token scope or rate limit).'), { code: 'FORBIDDEN' });
    if (status === 404) return Object.assign(new Error('Repository or folder not found. The token may lack access to penReader.'), { code: 'NOT_FOUND' });
    return Object.assign(new Error(`GitHub answered HTTP ${status}.`), { code: 'HTTP' });
};

const getJson = async (url, token) => {
    let res;
    try {
        res = await fetch(url, { headers: githubHeaders(token) });
    } catch (e) {
        throw Object.assign(new Error("Can't reach GitHub. Check your connection."), { code: 'OFFLINE' });
    }
    if (!res.ok) throw githubError(res.status);
    return res.json();
};

/**
 * The `.mdx` files under the source folder — one level of sub-folders deep,
 * which is how the repository is laid out (one folder per dictionary).
 * @returns {Promise<Array<{id, name, shortName, style, order, fileName, path, size, sha}>>}
 */
export const listRemoteDictionaries = async (token) => {
    if (!token) throw Object.assign(new Error('A GitHub token is needed to list the dictionaries.'), { code: 'AUTH' });
    const top = await getJson(contentsUrl(DICTIONARY_SOURCE.path), token);
    const files = [];
    const dirs = [];
    for (const item of Array.isArray(top) ? top : []) {
        if (item.type === 'file' && /\.mdx$/i.test(item.name)) files.push(item);
        else if (item.type === 'dir') dirs.push(item);
    }
    for (const d of dirs) {
        const inner = await getJson(contentsUrl(d.path), token);
        for (const item of Array.isArray(inner) ? inner : []) {
            if (item.type === 'file' && /\.mdx$/i.test(item.name)) files.push(item);
        }
    }
    // A Git-LFS file (the 192 MB LDOCE 6) lists as its ~134-byte pointer;
    // the file's own metadata carries the real size.
    for (const f of files) {
        if (f.size != null && f.size < 512) {
            try { f.size = (await getJson(contentsUrl(f.path), token)).size ?? f.size; } catch (_) {}
        }
    }
    const list = files.map(f => ({
        ...describeDictionary(f.name),
        fileName: f.name,
        path: f.path,
        size: f.size,
        sha: f.sha,
    })).sort(byOrder);
    try { await AsyncStorage.setItem(REMOTE_LIST_KEY, JSON.stringify(list)); } catch (_) {}
    return list;
};

/** The last fetched remote list, so Settings can show it before any network call. */
export const getCachedRemoteDictionaries = async () => {
    try {
        const raw = await AsyncStorage.getItem(REMOTE_LIST_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list : [];
    } catch (_) { return []; }
};

// ── Install / remove ─────────────────────────────────────────────────────────

const _inFlight = new Map(); // id → promise

/**
 * Downloads one dictionary from GitHub and indexes it.
 * `onProgress({ phase: 'download'|'index', percent })`.
 * Resolves to the install record. Throws with `code` OFFLINE / AUTH /
 * NO_SPACE / HTTP / BAD_FILE.
 */
export const installDictionary = (remote, token, onProgress) => {
    if (_inFlight.has(remote.id)) return _inFlight.get(remote.id);
    const job = _install(remote, token, onProgress).finally(() => _inFlight.delete(remote.id));
    _inFlight.set(remote.id, job);
    return job;
};

export const isInstalling = (id) => _inFlight.has(id);

const _install = async (remote, token, onProgress) => {
    if (!token) throw Object.assign(new Error('A GitHub token is needed to download dictionaries.'), { code: 'AUTH' });
    ensureDir();
    const target = mdxFile(remote.id);
    const tmp = new File(dir(), `${remote.id}.mdx.part`);
    try { if (tmp.exists) tmp.delete(); } catch (_) {}

    // Where the bytes actually are. The file's metadata carries a short-lived
    // pre-signed download_url (media.githubusercontent.com for a Git-LFS file
    // — the 192 MB LDOCE 6 — raw.githubusercontent.com otherwise) plus the
    // real size, which the folder listing misreports for LFS files (pointer
    // bytes). Asking the contents API for raw content instead would hand over
    // the 134-byte LFS pointer.
    let sourceUrl = contentsUrl(remote.path);
    let sourceHeaders = githubHeaders(token, 'application/vnd.github.raw+json');
    let expectedSize = remote.size || 0;
    try {
        const fileMeta = await getJson(contentsUrl(remote.path), token);
        if (fileMeta?.download_url) {
            sourceUrl = fileMeta.download_url; // pre-signed: no auth headers wanted
            sourceHeaders = null;
        }
        if (fileMeta?.size) expectedSize = fileMeta.size;
    } catch (e) {
        if (e?.code === 'AUTH' || e?.code === 'OFFLINE') throw e;
        // Anything else: fall back to the contents API download below.
    }

    const free = await FileSystem.getFreeDiskStorageAsync().catch(() => null);
    if (free != null && expectedSize && free < expectedSize * 1.2 + 50 * 1024 * 1024) {
        throw Object.assign(new Error('Not enough free space for this dictionary.'), { code: 'NO_SPACE' });
    }

    log('DICT', 'Downloading dictionary', { id: remote.id, size: expectedSize });
    const download = FileSystem.createDownloadResumable(
        sourceUrl,
        tmp.uri,
        sourceHeaders ? { headers: sourceHeaders } : {},
        ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
            const total = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : expectedSize;
            if (onProgress && total > 0) onProgress({ phase: 'download', percent: Math.min(99, Math.round((totalBytesWritten / total) * 100)) });
        },
    );
    let res;
    try {
        res = await download.downloadAsync();
    } catch (e) {
        try { if (tmp.exists) tmp.delete(); } catch (_) {}
        throw Object.assign(new Error("Download failed. Check your connection."), { code: 'OFFLINE', cause: e });
    }
    if (!res || res.status < 200 || res.status >= 300) {
        try { if (tmp.exists) tmp.delete(); } catch (_) {}
        throw githubError(res?.status ?? 0);
    }
    if (tmp.exists && tmp.size != null && tmp.size < 512) {
        // No MDX is this small — a Git-LFS pointer, a JSON error body, or nothing.
        let text = '';
        try { text = tmp.textSync(); } catch (_) {}
        try { tmp.delete(); } catch (_) {}
        throw Object.assign(new Error(text.startsWith('version https://git-lfs')
            ? 'GitHub returned the Git-LFS pointer instead of the file.'
            : 'GitHub returned something other than the dictionary file.'), { code: 'BAD_FILE' });
    }
    if (expectedSize && tmp.exists && tmp.size != null && Math.abs(tmp.size - expectedSize) > 16) {
        // A JSON error body or an HTML page instead of the file.
        try { tmp.delete(); } catch (_) {}
        throw Object.assign(new Error('GitHub returned something other than the dictionary file.'), { code: 'BAD_FILE' });
    }
    try { if (target.exists) target.delete(); } catch (_) {}
    await FileSystem.moveAsync({ from: tmp.uri, to: target.uri });

    // Parse + index. A file that doesn't parse is removed again.
    let mdx;
    try {
        mdx = MdxFile.open(fileReader(target));
    } catch (e) {
        try { target.delete(); } catch (_) {}
        throw Object.assign(new Error(`Not a readable MDX file: ${e?.message || e}`), { code: 'BAD_FILE' });
    }
    if (onProgress) onProgress({ phase: 'index', percent: 0 });
    const blocks = await mdx.buildBlockIndex((done, total) => {
        if (onProgress) onProgress({ phase: 'index', percent: Math.round((done / total) * 100) });
    });
    const meta = {
        version: INSTALL_VERSION,
        ...describeDictionary(remote.fileName),
        title: mdx.title || titleFor(remote.fileName),
        fileName: remote.fileName,
        path: remote.path,
        sha: remote.sha || null,
        size: target.size ?? remote.size ?? 0,
        entries: mdx.numEntries,
        installedAt: Date.now(),
        blocks,
    };
    metaFile(remote.id).write(JSON.stringify(meta));
    closeDictionary(remote.id);
    invalidate();
    log('DICT', 'Dictionary installed', { id: remote.id, entries: meta.entries, keyBlocks: blocks.length });
    if (onProgress) onProgress({ phase: 'index', percent: 100 });
    const { blocks: _b, ...summary } = meta;
    return summary;
};

export const deleteDictionary = async (id) => {
    closeDictionary(id);
    for (const f of [mdxFile(id), metaFile(id), new File(dir(), `${id}.mdx.part`)]) {
        try { if (f.exists) f.delete(); } catch (_) {}
    }
    try {
        const saved = await AsyncStorage.getItem(SELECTED_DICTIONARY_KEY);
        if (saved === id) await AsyncStorage.removeItem(SELECTED_DICTIONARY_KEY);
    } catch (_) {}
    invalidate();
    log('DICT', 'Dictionary removed', { id });
};

/** Bytes on disk for all installed dictionaries. */
export const dictionariesDiskUsage = () =>
    getInstalledDictionaries().reduce((sum, d) => sum + (d.size || 0), 0);
