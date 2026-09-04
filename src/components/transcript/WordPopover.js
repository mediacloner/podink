import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather as Icon } from '@expo/vector-icons';
import * as Speech from 'expo-speech';
import { createAudioPlayer } from 'expo-audio';
import { useNavigation } from '@react-navigation/native';
import { radii, withAlpha, useTheme, useStyles } from '../../theme';
import {
    addVocabWord, getVocabWords, isVocabWordSaved,
    recordLookup, removeVocabWord,
} from '../../services/vocabularyService';
import { log } from '../../services/logService';
import { onLibraryChange } from '../../services/libraryEvents';
import {
    getInstalledDictionaries, getSelectedDictionaryId, setSelectedDictionaryId,
    lookupWord, probeDictionaries,
} from '../../services/dictionaryService';
import { FUNCTION_WORDS, firstDefinitionText, flattenEntry } from '../../services/dictionaryHtml';
import {
    WIKIPEDIA_HEADERS, fetchListEntries, fetchWikipediaSummary, isListPage, largeImage, lookupWikipedia,
    nameCandidates, wikipediaEntryHtml,
} from '../../api/wikipedia';
import { fetchTranslation, fetchWordInfo, langLabel, translateErrorMessage } from './translate';
import { fetchDefinitions } from './dictionary';
import { askAssistantAboutWord, copyText, shareText } from './share';
import SheetModal, { AskAssistantButton, SheetIconButton } from './SheetModal';
import DictionaryEntry from './DictionaryEntry';
import ImageViewer from './ImageViewer';

// In-memory lookup cache, keyed by language + normalized word.
const _cache = new Map();
// The sentence translation is cached separately: the same word turns up in
// different sentences, and each one needs its own contextual rendering.
const _ctxCache = new Map();
// Wikipedia answers, keyed by the candidate titles (or, for an entry picked
// from a list, by its title); a miss is cached as null.
const _wikiCache = new Map();

// How many entries of a list page show before "Show all".
const WIKI_LIST_PREVIEW = 8;

// Second phase for a disambiguation or surname list: its entries with their
// real article titles (read from the wikitext), fetched after the page is
// already on screen so a slow read never delays the card. The upgraded
// value is cached under `key` and handed to `apply`; a failure just leaves
// the page's own list (not tappable) in place.
const loadListEntries = (page, key, signal, apply) =>
    fetchListEntries(page.title, page.lang, signal)
        .then(entries => {
            if (!entries.length) return;
            const value = { page, entries };
            _wikiCache.set(key, value);
            apply(value);
        })
        .catch(e => {
            if (e?.name === 'AbortError') return;
            log('DICT', 'Wikipedia entries failed', { title: page.title, error: String(e?.message || e) });
        });

// The article's intro (or a list page's entries) flattened like a dictionary
// record. The card draws the title line itself (with the thumbnail), so no
// paragraph gets the headword treatment a dictionary entry's first one has.
const wikiFlats = (page, entries) => {
    const flat = flattenEntry(wikipediaEntryHtml(page, entries));
    flat.paragraphs.forEach(p => { p.headword = false; });
    return [flat];
};

const IS_CAPITALISED = /^\p{Lu}/u;
const CLITIC = /['’](?:s|re|ll|ve|d|m)$/;

const IS_WORD_CHAR = /[\p{L}\p{N}]/u;

// Splits a sentence into alternating plain/matched segments so the looked-up
// word can be emphasised in place: even indices are plain text, odd ones are
// occurrences of the word. Display only — a plain scan rather than a built
// regex, since only literals are checked when the bundle is compiled.
const splitOnWord = (sentence, word) => {
    const needle = (word || '').trim().toLowerCase();
    if (!needle) return [sentence];
    const hay = sentence.toLowerCase();
    const parts = [];
    let plainFrom = 0;
    let search = 0;
    for (;;) {
        const at = hay.indexOf(needle, search);
        if (at < 0) break;
        search = at + needle.length;
        // Skip hits buried inside a longer word ('run' in 'running').
        const before = at > 0 ? sentence[at - 1] : '';
        const after = sentence[search] ?? '';
        if (IS_WORD_CHAR.test(before) || IS_WORD_CHAR.test(after)) continue;
        parts.push(sentence.slice(plainFrom, at), sentence.slice(at, search));
        plainFrom = search;
    }
    parts.push(sentence.slice(plainFrom));
    return parts;
};

export const normalizeWord = (raw) =>
    // Unicode-aware edge-trim so accented loanwords ('café', 'naïve', 'résumé')
    // aren't mangled to 'caf'/'na'/'r' before lookup and save.
    (raw || '').toLowerCase().replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');

// Bottom-sheet word card: a quick translation, the sentence in context, and
// the entry from one of the offline MDict dictionaries (penReader set), with
// a dictionary selector in the footer. `data` is null (hidden) or
// { word, prevWords, nextWords, startMs, contextText, contextTranslation? } —
// the last one is the sentence's translation when the caller already has it
// (a word tapped inside the translation card), shown without a request.
//
// The dictionary lookup is local and never waits for the network: Google's
// translation is supplementary and its failures stay inside its own block.
const WordPopover = ({ data, lang = 'es', episodeId, episodeTitle, onClose, onReplay }) => {
    const { colors } = useTheme();
    const st = useStyles(makeStyles);
    const navigation = useNavigation();
    const [lookup, setLookup] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [ctxTranslation, setCtxTranslation] = useState('');
    const [saved, setSaved] = useState(false);
    const [savedId, setSavedId] = useState(null);
    const [saving, setSaving] = useState(false);
    const [copied, setCopied] = useState(false);
    const [speaking, setSpeaking] = useState(false);

    // Offline dictionaries
    const [dicts, setDicts] = useState([]);
    const [dictId, setDictId] = useState(null);
    const [dictsReady, setDictsReady] = useState(false);
    const [dict, setDict] = useState({ status: 'idle' }); // idle | loading | ready | missing | error | none
    const [pickerOpen, setPickerOpen] = useState(false);
    const [probe, setProbe] = useState(null);   // { [id]: boolean } for the current word
    // A different headword to show: a cross-reference tap, or "the word
    // itself" after the sentence resolved to a phrasal verb or an idiom.
    const [override, setOverride] = useState(null);
    // Wikipedia: idle | loading | ready { page, entries } | none | error { kind }
    const [wiki, setWiki] = useState({ status: 'idle' });
    // An entry tapped in a disambiguation / surname list: { title, from }.
    const [wikiPick, setWikiPick] = useState(null);
    const [wikiPicked, setWikiPicked] = useState({ status: 'idle' });
    const [wikiExpanded, setWikiExpanded] = useState(false);
    // The Wikipedia picture opened full screen: null or the ImageViewer's `image`.
    const [zoomImage, setZoomImage] = useState(null);

    const scrollRef = useRef(null);
    const bodyRef = useRef(null);

    const visible = !!data;
    const word = data?.word ?? '';
    // The chunk the word sits in — already carried for the vocabulary row.
    const sentence = (data?.contextText ?? '').trim();
    const givenCtxTranslation = (data?.contextTranslation ?? '').trim();
    const normalized = normalizeWord(word);
    const shownWord = override?.word || word;

    // ── Pronunciation ────────────────────────────────────────────────────────
    // On-device text-to-speech is the primary voice: it works offline, for
    // every word, and doesn't take audio focus away from the podcast. The
    // dictionary's recordings are only a fallback — its media host answers
    // 502 for most words (that was the "speaker does nothing" bug), and a
    // second player grabbing focus pauses the podcast underneath.
    const soundRef = useRef(null);
    const releaseRecording = useCallback(() => {
        try { soundRef.current?.remove(); } catch (_) {}
        soundRef.current = null;
    }, []);

    const stopPronunciation = useCallback(() => {
        Speech.stop().catch(() => {});
        releaseRecording();
        setSpeaking(false);
    }, [releaseRecording]);

    useEffect(() => {
        if (!visible) stopPronunciation();
        return stopPronunciation;
    }, [visible, stopPronunciation]);

    const playRecording = useCallback(() => {
        const uri = lookup?.audioUrl;
        if (!uri) return;
        releaseRecording();
        try {
            const player = createAudioPlayer({ uri });
            soundRef.current = player;
            player.play();
        } catch (e) {
            log('UI', 'Pronunciation recording failed', { uri, error: String(e?.message || e) });
        }
    }, [lookup, releaseRecording]);

    const pronounce = useCallback(() => {
        const spoken = (override?.word || normalized || word).trim();
        if (!spoken) return;
        releaseRecording();
        setSpeaking(true);
        // Android queues utterances (QUEUE_ADD): flush what's still being said.
        Speech.stop().catch(() => {});
        try {
            Speech.speak(spoken, {
                language: 'en-US',
                rate: 0.9,
                onDone: () => setSpeaking(false),
                onStopped: () => setSpeaking(false),
                onError: (e) => {
                    setSpeaking(false);
                    log('UI', 'TTS failed, falling back to recording', { word: spoken, error: String(e?.message || e) });
                    playRecording();
                },
            });
        } catch (e) {
            setSpeaking(false);
            log('UI', 'TTS unavailable, falling back to recording', { word: spoken, error: String(e?.message || e) });
            playRecording();
        }
    }, [override, normalized, word, releaseRecording, playRecording]);

    // ── Installed dictionaries ───────────────────────────────────────────────
    const refreshDicts = useCallback(async () => {
        try {
            const list = getInstalledDictionaries();
            setDicts(list);
            const id = await getSelectedDictionaryId();
            setDictId(id);
        } catch (e) {
            log('DICT', 'Reading installed dictionaries failed', { error: String(e?.message || e) });
            setDicts([]);
            setDictId(null);
        }
        setDictsReady(true);
    }, []);

    useEffect(() => {
        if (!visible) return;
        refreshDicts();
        return onLibraryChange((p) => { if (p?.type === 'dictionaries-changed') refreshDicts(); });
    }, [visible, refreshDicts]);

    // Per-open reset.
    useEffect(() => {
        if (!visible) return;
        setOverride(null);
        setPickerOpen(false);
        setProbe(null);
        setWikiPick(null);
        setWikiExpanded(false);
        setZoomImage(null);
    }, [visible, word, data]);

    // ── Offline lookup ───────────────────────────────────────────────────────
    const hasDicts = dicts.length > 0;
    useEffect(() => {
        if (!visible || !dictsReady) return;
        if (!hasDicts || !dictId) { setDict({ status: 'none' }); return; }
        if (!normalized) { setDict({ status: 'missing' }); return; }
        setDict({ status: 'loading' });
        // Synchronous, but a tick later so the sheet starts sliding first.
        const t = setTimeout(() => {
            try {
                const query = override
                    ? { word: override.word, forceWord: true }
                    : { word, prevWords: data?.prevWords || [], nextWords: data?.nextWords || [] };
                const t0 = Date.now();
                const res = lookupWord(dictId, query);
                log('DICT', 'Lookup', {
                    dict: dictId, word: query.word, ms: Date.now() - t0,
                    found: !!res, entry: res?.result?.entry, phrase: res?.phraseFound || undefined,
                });
                setDict(res ? { status: 'ready', ...res } : { status: 'missing' });
            } catch (e) {
                log('DICT', 'Lookup failed', { dict: dictId, word, error: String(e?.message || e) });
                setDict({ status: 'error', message: e?.message || String(e) });
            }
        }, 0);
        return () => clearTimeout(t);
    }, [visible, dictsReady, hasDicts, dictId, normalized, word, override, data]);

    // Which other dictionaries have the word — for the picker and the miss
    // message. One dictionary per tick so the card stays responsive.
    const probeWord = override?.word || word;
    const wantProbe = visible && hasDicts && (pickerOpen || dict.status === 'missing');
    useEffect(() => {
        if (!wantProbe || !probeWord) return;
        let cancelled = false;
        const ids = dicts.map(d => d.id);
        const results = {};
        (async () => {
            for (const id of ids) {
                if (cancelled) return;
                Object.assign(results, probeDictionaries(probeWord, [id]));
                setProbe({ ...results });
                await new Promise(r => setTimeout(r, 0));
            }
        })();
        return () => { cancelled = true; };
    }, [wantProbe, probeWord, dicts]);

    const chooseDictionary = useCallback((id) => {
        setDictId(id);
        setPickerOpen(false);
        setSelectedDictionaryId(id);
    }, []);

    const openSettings = useCallback(() => {
        onClose?.();
        setTimeout(() => navigation.navigate('Settings'), 250);
    }, [onClose, navigation]);

    const onLink = useCallback((target) => {
        const t = String(target || '').trim();
        if (!t) return;
        setOverride({ word: t, from: shownWord });
    }, [shownWord]);

    // Where the phrase's heading (phrasal verb, idiom) sits in the body; the
    // card scrolls there once it is measured, and again when the chip under
    // the trail is tapped.
    const highlightYRef = useRef(null);
    const scrollToHighlight = useCallback(() => {
        const y = highlightYRef.current;
        if (y == null) return;
        scrollRef.current?.scrollTo({ y: Math.max(0, y - 8), animated: true });
    }, []);
    const onHighlightLayout = useCallback((y) => {
        highlightYRef.current = y;
        scrollToHighlight();
    }, [scrollToHighlight]);
    useEffect(() => { highlightYRef.current = null; }, [dict]);

    // ── Wikipedia (names, places — what the dictionaries leave out) ──────────
    // A capitalised word inside a clause is taken for a name; one that opens
    // the clause may be a capitalised common word ("There's"), so it — like
    // any lower-case word — is only tried once the dictionary has drawn a
    // blank. Function words and the pronoun "I" never go. As with phrasal
    // verbs, the capitalised words around the tap are tried together first
    // ("Los Angeles", "Avidius Cassius"), then the word on its own.
    const wikiCandidates = useMemo(
        () => (data ? nameCandidates({ word, prevWords: data.prevWords || [], nextWords: data.nextWords || [] }) : []),
        [data, word],
    );
    const capitalised = IS_CAPITALISED.test(word) && !/^I(?:['’]|$)/.test(word);
    const dictSettled = dict.status === 'ready' || dict.status === 'missing' || dict.status === 'none';
    const wikiWanted = visible && !override && !!normalized && dictSettled
        && !FUNCTION_WORDS.has(normalized.replace(CLITIC, ''))
        && (capitalised ? ((data?.prevWords || []).length > 0 || dict.status !== 'ready') : dict.status === 'missing');
    const wikiKey = wikiWanted && wikiCandidates.length ? `en:${wikiCandidates.join('|')}` : '';
    useEffect(() => {
        if (!wikiKey) { setWiki({ status: 'idle' }); return; }
        let stale = false;
        const ctrl = new AbortController();
        const show = (value) => { if (!stale) setWiki(value ? { status: 'ready', ...value } : { status: 'none' }); };
        const cached = _wikiCache.get(wikiKey);
        if (cached !== undefined) {
            show(cached);
            // A list whose entries never arrived (offline, throttled): try again.
            if (cached && !cached.entries && isListPage(cached.page)) loadListEntries(cached.page, wikiKey, ctrl.signal, show);
            return () => { stale = true; ctrl.abort(); };
        }
        setWiki({ status: 'loading' });
        const t0 = Date.now();
        lookupWikipedia(wikiCandidates, { lang: 'en', signal: ctrl.signal })
            .then(page => {
                if (stale) return;
                log('DICT', 'Wikipedia', { tried: wikiCandidates, found: page?.title || null, list: page ? isListPage(page) : undefined, ms: Date.now() - t0 });
                const value = page ? { page, entries: null } : null;
                _wikiCache.set(wikiKey, value);
                show(value);
                if (page && isListPage(page)) return loadListEntries(page, wikiKey, ctrl.signal, show);
            })
            .catch(e => {
                if (stale || e?.name === 'AbortError') return;
                log('DICT', 'Wikipedia lookup failed', { tried: wikiCandidates, error: String(e?.message || e) });
                setWiki({ status: 'error', kind: e?.kind });
            });
        return () => { stale = true; ctrl.abort(); };
    }, [wikiKey, wikiCandidates]);

    // An entry picked from the list: its own article, shown in place of the
    // list with a way back. Cached by title like the lookups above.
    useEffect(() => {
        if (!wikiPick) { setWikiPicked({ status: 'idle' }); return; }
        const key = `en:pick:${wikiPick.title}`;
        let stale = false;
        const ctrl = new AbortController();
        const show = (value) => { if (!stale) setWikiPicked(value ? { status: 'ready', ...value } : { status: 'none' }); };
        const cached = _wikiCache.get(key);
        if (cached !== undefined) {
            show(cached);
            if (cached && !cached.entries && isListPage(cached.page)) loadListEntries(cached.page, key, ctrl.signal, show);
            return () => { stale = true; ctrl.abort(); };
        }
        setWikiPicked({ status: 'loading' });
        fetchWikipediaSummary(wikiPick.title, 'en', ctrl.signal)
            .then(page => {
                if (stale) return;
                const value = page ? { page, entries: null } : null;
                _wikiCache.set(key, value);
                show(value);
                if (page && isListPage(page)) return loadListEntries(page, key, ctrl.signal, show);
            })
            .catch(e => {
                if (stale || e?.name === 'AbortError') return;
                log('DICT', 'Wikipedia entry failed', { title: wikiPick.title, error: String(e?.message || e) });
                setWikiPicked({ status: 'error', kind: e?.kind });
            });
        return () => { stale = true; ctrl.abort(); };
    }, [wikiPick]);
    useEffect(() => { setWikiExpanded(false); }, [wikiPick]);

    // ── Online lookup (translation) ──────────────────────────────────────────
    useEffect(() => {
        if (!visible) return;
        let stale = false;
        const ctrl = new AbortController();

        setSaved(false);
        setSavedId(null);
        setError('');
        setCtxTranslation('');
        setCopied(false);

        if (!normalized) {
            setLookup({ translation: '', senses: [], phonetic: '', audioUrl: '', meanings: [] });
            setLoading(false);
            return;
        }

        // A bare-word translation is often the wrong sense outright ('left' →
        // 'izquierda' in a sentence that means 'salió'), so the containing
        // sentence is translated too and shown alongside. It's supplementary:
        // a failure here leaves the rest of the sheet untouched.
        if (sentence && sentence.toLowerCase() !== word.trim().toLowerCase()) {
            const ctxKey = `${lang}:${sentence}`;
            if (givenCtxTranslation) _ctxCache.set(ctxKey, givenCtxTranslation);
            const ctxCached = _ctxCache.get(ctxKey);
            if (ctxCached) {
                setCtxTranslation(ctxCached);
            } else {
                fetchTranslation(sentence, lang, ctrl.signal)
                    .then(t => {
                        if (stale) return;
                        const trimmed = (t || '').trim();
                        if (trimmed) _ctxCache.set(ctxKey, trimmed);
                        setCtxTranslation(trimmed);
                    })
                    .catch(() => {});
            }
        }

        recordLookup(word, normalized, episodeId).catch(() => {});
        isVocabWordSaved(normalized)
            .then(v => { if (!stale) setSaved(!!v); })
            .catch(() => {});

        const key = `${lang}:${normalized}`;
        const cached = _cache.get(key);
        if (cached) {
            setLookup(cached);
            setLoading(false);
        } else {
            setLookup(null);
            setLoading(true);
            // Translation and — only as a stand-in while no offline dictionary
            // is installed — online English definitions, in parallel.
            const wantOnlineDefs = !getInstalledDictionaries().length;
            Promise.allSettled([
                fetchWordInfo(normalized, lang, ctrl.signal),
                wantOnlineDefs ? fetchDefinitions(normalized, ctrl.signal) : Promise.resolve({ phonetic: '', audioUrl: '', meanings: [] }),
            ]).then(([tRes, dRes]) => {
                if (stale) return;
                const t = tRes.status === 'fulfilled' ? tRes.value : { translation: '', senses: [] };
                const d = dRes.status === 'fulfilled' ? dRes.value : { phonetic: '', audioUrl: '', meanings: [] };
                const info = { ...t, ...d };
                if (!info.translation && !info.senses.length && !info.meanings.length) {
                    // Empty lookup — surface as error and DON'T cache, so
                    // the next open retries instead of a permanent blank.
                    const reason = tRes.status === 'rejected' ? tRes.reason : null;
                    setError(translateErrorMessage(
                        reason,
                        reason ? 'Translation failed. Try again.' : 'No translation found for this word.',
                    ));
                    setLookup(info);
                    setLoading(false);
                    return;
                }
                _cache.set(key, info);
                setLookup(info);
                setLoading(false);
            });
        }

        return () => {
            stale = true;
            ctrl.abort();
        };
    }, [visible, word, normalized, sentence, givenCtxTranslation, lang, episodeId]);

    // ── Copy / share / ask ───────────────────────────────────────────────────
    useEffect(() => {
        if (!copied) return;
        const t = setTimeout(() => setCopied(false), 1400);
        return () => clearTimeout(t);
    }, [copied]);

    const onCopy = useCallback(async () => { if (await copyText(shownWord)) setCopied(true); }, [shownWord]);
    const onShare = useCallback(() => {
        const hasSentence = sentence && sentence.toLowerCase() !== word.trim().toLowerCase();
        shareText(hasSentence ? `${word}\n\n“${sentence}”` : word, 'Share word');
    }, [word, sentence]);
    const onAsk = useCallback(() => askAssistantAboutWord(word, sentence, lang), [word, sentence, lang]);

    // ── Save / replay ────────────────────────────────────────────────────────
    const toggleSave = useCallback(async () => {
        if (!data || saving || !normalized) return;
        setSaving(true);
        try {
            if (saved) {
                let id = savedId;
                if (id == null) {
                    // Opened on an already-saved word: resolve the row id by normalized.
                    const all = await getVocabWords();
                    id = all.find(w => w.normalized === normalized)?.id;
                }
                if (id != null) await removeVocabWord(id);
                setSaved(false);
                setSavedId(null);
            } else {
                // Prefer the offline dictionary's first definition line, then a
                // real English definition, then the translated senses.
                let definition = '';
                if (dict.status === 'ready' && dict.flats?.length) {
                    const line = firstDefinitionText(dict.flats[0]);
                    if (line) definition = `${dict.result.entry}: ${line}`;
                }
                if (!definition) {
                    const firstMeaning = lookup?.meanings?.[0];
                    const firstDef = firstMeaning?.definitions?.[0]?.definition;
                    const firstSense = lookup?.senses?.[0];
                    definition = firstDef
                        ? (firstMeaning.pos ? `${firstMeaning.pos}: ${firstDef}` : firstDef)
                        : (firstSense ? `${firstSense.pos}: ${firstSense.terms.join(', ')}` : '');
                }
                // A name the dictionaries lack: Wikipedia's one-line description.
                const article = (wikiPick ? wikiPicked : wiki);
                if (!definition && article.status === 'ready' && !article.page.disambiguation) {
                    definition = article.page.description ? `${article.page.title}: ${article.page.description}` : article.page.title;
                }
                const id = await addVocabWord({
                    word,
                    normalized,
                    translation: lookup?.translation || '',
                    definition,
                    language: lang,
                    episode_id: episodeId,
                    episode_title: episodeTitle,
                    context_text: data.contextText || '',
                    word_start_ms: Math.round(data.startMs ?? 0),
                });
                setSavedId(id ?? null);
                setSaved(true);
            }
        } catch (_) {}
        setSaving(false);
    }, [data, saving, saved, savedId, normalized, word, lookup, dict, wiki, wikiPick, wikiPicked, lang, episodeId, episodeTitle]);

    const handleReplay = useCallback(() => {
        onReplay(Math.max(0, (data?.startMs ?? 0) - 1000));
    }, [onReplay, data]);

    // What the Wikipedia section shows: the picked entry when there is one,
    // else the page the lookup found.
    const wikiShown = wikiPick ? wikiPicked : wiki;
    const wikiPage = wikiShown.status === 'ready' ? wikiShown.page : null;
    const wikiEntries = wikiShown.status === 'ready' ? wikiShown.entries : null;
    const wikiTotal = wikiEntries ? wikiEntries.length : 0;
    const wikiFlatList = useMemo(() => {
        if (!wikiPage) return null;
        const shown = wikiEntries && !wikiExpanded ? wikiEntries.slice(0, WIKI_LIST_PREVIEW) : wikiEntries;
        return wikiFlats(wikiPage, shown);
    }, [wikiPage, wikiEntries, wikiExpanded]);
    const openWikipedia = useCallback(() => {
        if (wikiPage?.url) Linking.openURL(wikiPage.url).catch(() => {});
    }, [wikiPage]);
    const openImage = useCallback(() => {
        const large = largeImage(wikiPage);
        if (!large) return;
        setZoomImage({
            uri: large.uri,
            thumbUri: wikiPage.thumbnail?.uri || null,
            width: large.width,
            height: large.height,
            caption: wikiPage.title,
            headers: WIKIPEDIA_HEADERS,
        });
    }, [wikiPage]);
    const closeImage = useCallback(() => setZoomImage(null), []);
    // Where the section sits in the card body, so picking an entry scrolls
    // the card back up to the article that replaces the list.
    const wikiViewRef = useRef(null);
    const wikiYRef = useRef(null);
    const onWikiLayout = useCallback(() => {
        const node = wikiViewRef.current;
        const host = bodyRef.current;
        if (!node || !host) return;
        try { node.measureLayout(host, (_x, y) => { wikiYRef.current = y; }, () => {}); } catch (_) {}
    }, []);
    // An entry of the list, or a cross-reference inside a picked article.
    const onWikiLink = useCallback((target) => {
        const t = String(target || '').trim();
        if (!t || !wikiPage) return;
        setWikiPick({ title: t, from: wikiPage.title });
        const y = wikiYRef.current;
        if (y != null) scrollRef.current?.scrollTo({ y: Math.max(0, y - 8), animated: true });
    }, [wikiPage]);

    // ── Render ───────────────────────────────────────────────────────────────
    const current = dicts.find(d => d.id === dictId) || null;
    const trail = dict.status === 'ready' ? (dict.result.trail || []) : [];
    const alternates = dict.status === 'ready' ? (dict.result.alternates || []).slice(0, 3) : [];
    const othersWithWord = probe ? dicts.filter(d => d.id !== dictId && probe[d.id]) : [];

    const header = (
        <>
            <View style={st.wordRow}>
                <Text style={st.word} numberOfLines={2}>{shownWord}</Text>
                <TouchableOpacity
                    style={[st.speakerBtn, speaking && st.speakerBtnActive]}
                    onPress={pronounce}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    activeOpacity={0.7}
                    accessibilityRole='button'
                    accessibilityLabel={`Pronounce ${shownWord}`}
                >
                    <Icon name='volume-2' size={17} color={speaking ? colors.bg : colors.accent} />
                </TouchableOpacity>
            </View>
            {!!lookup?.phonetic && !override && <Text style={st.phonetic}>{lookup.phonetic}</Text>}
            <View style={st.langRow}>
                <Text style={st.lang}>English</Text>
                <Icon name='arrow-right' size={13} color={colors.textFaint} />
                <Text style={st.lang}>{langLabel(lang)}</Text>
                <View style={st.headerActions}>
                    <SheetIconButton
                        icon={saved ? 'check' : 'bookmark'}
                        label={saved ? 'Remove from vocabulary' : 'Save to vocabulary'}
                        onPress={toggleSave}
                        active={saved}
                    />
                    <SheetIconButton icon={copied ? 'check' : 'copy'} label='Copy word' onPress={onCopy} active={copied} />
                    <SheetIconButton icon='share-2' label='Share word and sentence' onPress={onShare} />
                </View>
            </View>
        </>
    );

    const footer = (
        <View style={st.actions}>
            <TouchableOpacity
                style={[st.actionBtn, st.actionBtnGhost, st.selectorBtn, pickerOpen && st.selectorBtnOpen]}
                onPress={() => (hasDicts ? setPickerOpen(o => !o) : openSettings())}
                activeOpacity={0.8}
                accessibilityRole='button'
                accessibilityLabel='Choose dictionary'
            >
                <Icon name='book-open' size={15} color={colors.accent} />
                <Text style={[st.actionText, st.selectorText]} numberOfLines={1}>
                    {current ? current.shortName : (dictsReady && !hasDicts ? 'Add dictionaries' : 'Dictionary')}
                </Text>
                <Icon name={pickerOpen ? 'chevron-up' : 'chevron-down'} size={15} color={colors.textMuted} />
            </TouchableOpacity>

            <TouchableOpacity style={[st.actionBtn, st.actionBtnGhost, st.replayBtn]} onPress={handleReplay} activeOpacity={0.8}>
                <Icon name='rotate-ccw' size={15} color={colors.textPrimary} />
                <Text style={[st.actionText, { color: colors.textPrimary }]}>Replay</Text>
            </TouchableOpacity>
        </View>
    );

    const picker = (
        <View>
            <Text style={st.sectionLabel}>Dictionaries</Text>
            {dicts.map((d, i) => {
                const selected = d.id === dictId;
                const has = probe ? probe[d.id] : undefined;
                return (
                    <TouchableOpacity
                        key={d.id}
                        style={[st.pickerRow, i < dicts.length - 1 && st.pickerRowBorder]}
                        onPress={() => chooseDictionary(d.id)}
                        activeOpacity={0.7}
                        accessibilityRole='radio'
                        accessibilityState={{ selected }}
                    >
                        <View style={{ flex: 1 }}>
                            <Text style={[st.pickerName, selected && st.pickerNameOn]}>{d.shortName}</Text>
                            <Text style={st.pickerSub} numberOfLines={1}>{d.name}</Text>
                        </View>
                        {has === true && <Text style={st.pickerHas}>{shownWord}</Text>}
                        {has === false && <Icon name='minus' size={14} color={colors.textFaint} />}
                        {selected && <Icon name='check' size={16} color={colors.accent} />}
                    </TouchableOpacity>
                );
            })}
            <TouchableOpacity style={st.manageRow} onPress={openSettings} activeOpacity={0.7} accessibilityRole='button'>
                <Icon name='settings' size={14} color={colors.accent} />
                <Text style={st.manageText}>Manage dictionaries…</Text>
            </TouchableOpacity>
        </View>
    );

    const dictionarySection = (
        <>
            <View style={st.sectionDivider} />
            <View style={st.dictHead}>
                <Text style={st.sectionLabel}>Dictionary</Text>
                {!!current && <Text style={st.dictName} numberOfLines={1}>{current.shortName}</Text>}
            </View>

            {(trail.length > 0 || override) && (
                <View style={st.trailRow}>
                    {override ? (
                        <TouchableOpacity style={st.trailBack} onPress={() => setOverride(null)} activeOpacity={0.7}>
                            <Icon name='arrow-left' size={13} color={colors.accent} />
                            <Text style={st.trailBackText}>{word}</Text>
                        </TouchableOpacity>
                    ) : null}
                    {trail.length > 0 && (
                        <Text style={st.trailText} numberOfLines={2}>
                            {trail.map((t, i) => (
                                <Text key={i} style={i === trail.length - 1 ? st.trailBold : undefined}>
                                    {i > 0 ? '  →  ' : ''}{t}
                                </Text>
                            ))}
                        </Text>
                    )}
                </View>
            )}

            {dict.status === 'ready' && !!dict.phraseFound && (
                <TouchableOpacity
                    style={st.phraseChip}
                    onPress={scrollToHighlight}
                    activeOpacity={0.7}
                    accessibilityLabel={`${dict.phraseKind || 'phrase'} ${dict.phraseFound}, shown below`}
                >
                    <Icon name='corner-right-down' size={13} color={colors.accent} />
                    <Text style={st.phraseChipText}>{dict.phraseKind || 'phrase'} · {dict.phraseFound}</Text>
                </TouchableOpacity>
            )}

            {dict.status === 'ready' && dict.result.phraseIsEntry && !override && (
                <TouchableOpacity style={st.inlineLink} onPress={() => setOverride({ word, from: dict.result.entry })} activeOpacity={0.7}>
                    <Text style={st.inlineLinkText}>Show ‘{word}’ on its own</Text>
                </TouchableOpacity>
            )}

            {dict.status === 'loading' && <ActivityIndicator color={colors.accent} style={{ marginVertical: 14 }} />}

            {dict.status === 'ready' && (
                <DictionaryEntry
                    flats={dict.flats}
                    highlight={dict.highlight}
                    onLink={onLink}
                    measureIn={bodyRef}
                    onHighlightLayout={onHighlightLayout}
                />
            )}

            {dict.status === 'ready' && alternates.length > 0 && (
                <View style={st.chipRow}>
                    <Text style={st.chipLabel}>See also</Text>
                    {alternates.map(a => (
                        <TouchableOpacity key={a} style={st.chip} onPress={() => onLink(a)} activeOpacity={0.7}>
                            <Text style={st.chipText}>{a}</Text>
                        </TouchableOpacity>
                    ))}
                </View>
            )}

            {dict.status === 'missing' && (
                <View style={st.missBlock}>
                    <Text style={st.missText}>
                        No entry for ‘{shownWord}’{current ? ` in ${current.shortName}` : ''}.
                    </Text>
                    {othersWithWord.length > 0 && (
                        <View style={st.chipRow}>
                            <Text style={st.chipLabel}>Try</Text>
                            {othersWithWord.map(d => (
                                <TouchableOpacity key={d.id} style={st.chip} onPress={() => chooseDictionary(d.id)} activeOpacity={0.7}>
                                    <Text style={st.chipText}>{d.shortName}</Text>
                                </TouchableOpacity>
                            ))}
                        </View>
                    )}
                </View>
            )}

            {dict.status === 'error' && <Text style={st.errorText}>Dictionary error: {dict.message}</Text>}

            {dict.status === 'none' && dictsReady && (
                <View style={st.hintCard}>
                    <Text style={st.hintText}>
                        No offline dictionaries yet. Download the penReader set — Oxford, Collins, Merriam-Webster, VOX… — in Settings.
                    </Text>
                    <TouchableOpacity style={st.hintBtn} onPress={openSettings} activeOpacity={0.8} accessibilityRole='button'>
                        <Icon name='download' size={14} color={colors.onAccent} />
                        <Text style={st.hintBtnText}>Add dictionaries</Text>
                    </TouchableOpacity>
                </View>
            )}
        </>
    );

    // Shown under the dictionary entry when there is one, in its place when
    // there is not. A disambiguation page ("Cassius may refer to…") only
    // stands in for a missing entry; next to a real one it would be noise.
    // The tapped word's own disambiguation next to a real dictionary entry
    // ("English", "Roman" → "may refer to…") would be noise, so that one
    // only stands in for a missing entry. A longer name's disambiguation
    // ("World Trade Center" from a tap on "Trade") is the answer and always
    // shows, as does anything the reader has picked from a list.
    const basePage = wiki.status === 'ready' ? wiki.page : null;
    const ownDisambiguation = !!basePage && basePage.disambiguation && basePage.title.toLowerCase() === normalized;
    const wikiVisible = !!wikiPick
        || wiki.status === 'loading'
        || (wiki.status === 'error' && dict.status === 'missing')
        || (!!basePage && (!ownDisambiguation || dict.status !== 'ready'));
    const wikiHiddenEntries = wikiEntries && !wikiExpanded ? Math.max(0, wikiTotal - WIKI_LIST_PREVIEW) : 0;
    const wikiSection = wikiVisible ? (
        <View ref={wikiViewRef} onLayout={onWikiLayout} collapsable={false}>
            <View style={st.sectionDivider} />
            <View style={st.dictHead}>
                <Text style={st.sectionLabel}>Wikipedia</Text>
                <Text style={st.dictName} numberOfLines={1}>English Wikipedia</Text>
            </View>

            {(wikiPick || (wikiPage && wikiPage.title.toLowerCase() !== word.toLowerCase())) && (
                <View style={st.trailRow}>
                    {!!wikiPick && (
                        <TouchableOpacity style={st.trailBack} onPress={() => setWikiPick(null)} activeOpacity={0.7} accessibilityRole='button'>
                            <Icon name='arrow-left' size={13} color={colors.accent} />
                            <Text style={st.trailBackText} numberOfLines={1}>{wikiPick.from}</Text>
                        </TouchableOpacity>
                    )}
                    {!!wikiPage && wikiPage.title.toLowerCase() !== word.toLowerCase() && (
                        <Text style={st.trailText} numberOfLines={2}>
                            {word}  →  <Text style={st.trailBold}>{wikiPage.title}</Text>
                        </Text>
                    )}
                </View>
            )}

            {wikiShown.status === 'loading' && <ActivityIndicator color={colors.accent} style={{ marginVertical: 14 }} />}

            {wikiShown.status === 'error' && (
                <Text style={st.softError}>
                    {wikiShown.kind === 'offline' ? "Can't reach Wikipedia. Check your connection." : 'Wikipedia is not answering right now.'}
                </Text>
            )}
            {wikiShown.status === 'none' && !!wikiPick && (
                <Text style={st.softError}>No Wikipedia article for ‘{wikiPick.title}’.</Text>
            )}

            {!!wikiPage && (
                <>
                    <View style={st.wikiHead}>
                        <View style={{ flex: 1 }}>
                            <Text style={st.wikiTitle}>{wikiPage.title}</Text>
                            <Text style={st.wikiDesc}>
                                {wikiPage.disambiguation
                                    ? (wikiEntries ? 'Several articles share this name — tap one' : 'Several Wikipedia articles share this name')
                                    : wikiPage.description}
                            </Text>
                        </View>
                        {!!wikiPage.thumbnail && (
                            <TouchableOpacity
                                onPress={openImage}
                                activeOpacity={0.8}
                                accessibilityRole='imagebutton'
                                accessibilityLabel='Enlarge picture'
                            >
                                <Image
                                    source={{ uri: wikiPage.thumbnail.uri, headers: WIKIPEDIA_HEADERS }}
                                    style={st.wikiThumb}
                                    accessibilityIgnoresInvertColors
                                />
                            </TouchableOpacity>
                        )}
                    </View>
                    <DictionaryEntry flats={wikiFlatList} onLink={onWikiLink} />
                    {wikiHiddenEntries > 0 && (
                        <TouchableOpacity style={st.inlineLink} onPress={() => setWikiExpanded(true)} activeOpacity={0.7} accessibilityRole='button'>
                            <Text style={st.inlineLinkText}>Show all {wikiTotal} entries</Text>
                        </TouchableOpacity>
                    )}
                    <TouchableOpacity style={st.wikiLink} onPress={openWikipedia} activeOpacity={0.7} accessibilityRole='link'>
                        <Icon name='external-link' size={13} color={colors.accent} />
                        <Text style={st.inlineLinkText}>Read on Wikipedia</Text>
                    </TouchableOpacity>
                </>
            )}
        </View>
    ) : null;

    return (
        <>
        <SheetModal visible={visible} onClose={onClose} header={header} footer={footer} maxHeight='88%' scrollRef={scrollRef}>
            <View ref={bodyRef} collapsable={false}>
                {pickerOpen ? picker : (
                    <>
                        {/* Translation — supplementary, its failure stays in this block */}
                        {loading ? (
                            <ActivityIndicator color={colors.accent} style={{ marginVertical: 10 }} />
                        ) : error && !lookup?.translation ? (
                            <Text style={st.softError}>{error}</Text>
                        ) : (
                            <>
                                <Text style={st.translation}>{lookup?.translation || '—'}</Text>
                                {(lookup?.senses ?? []).slice(0, 4).map((s, i) => (
                                    <View key={i} style={st.sense}>
                                        {!!s.pos && <Text style={st.pos}>{s.pos}</Text>}
                                        <Text style={st.terms}>{s.terms.join(', ')}</Text>
                                    </View>
                                ))}
                            </>
                        )}
                        {!!ctxTranslation && (
                            <>
                                <View style={st.sectionDivider} />
                                <Text style={st.sectionLabel}>In this sentence</Text>
                                <Text style={st.ctxEnglish}>
                                    {splitOnWord(sentence, word).map((part, i) => (
                                        i % 2 === 1
                                            ? <Text key={i} style={st.ctxWord}>{part}</Text>
                                            : part
                                    ))}
                                </Text>
                                <Text style={st.ctxTranslated}>{ctxTranslation}</Text>
                            </>
                        )}

                        {dict.status === 'ready'
                            ? <>{dictionarySection}{wikiSection}</>
                            : <>{wikiSection}{dictionarySection}</>}

                        {/* Online definitions only stand in while nothing is installed */}
                        {dict.status === 'none' && (lookup?.meanings ?? []).length > 0 && (
                            <>
                                <View style={st.sectionDivider} />
                                <Text style={st.sectionLabel}>English definitions</Text>
                                {lookup.meanings.map((m, i) => (
                                    <View key={i} style={st.meaning}>
                                        {!!m.pos && <Text style={st.pos}>{m.pos}</Text>}
                                        {m.definitions.map((d, j) => (
                                            <View key={j} style={st.defRow}>
                                                <Text style={st.defNum}>{j + 1}.</Text>
                                                <View style={st.defBody}>
                                                    <Text style={st.defText}>{d.definition}</Text>
                                                    {!!d.example && <Text style={st.defExample}>“{d.example}”</Text>}
                                                </View>
                                            </View>
                                        ))}
                                    </View>
                                ))}
                            </>
                        )}

                        <View style={st.askRow}>
                            <AskAssistantButton onPress={onAsk} compact />
                        </View>
                    </>
                )}
            </View>
        </SheetModal>
        {/* Its own Modal, shown after the card's, so it lands on top of it. */}
        <ImageViewer image={zoomImage} onClose={closeImage} />
        </>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    wordRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 4 },
    word: { flex: 1, color: colors.textPrimary, fontSize: 30, fontWeight: '700', letterSpacing: -0.4 },
    phonetic: { color: colors.textMuted, fontSize: 14, marginBottom: 6 },
    speakerBtn: {
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.hairlineFaint,
        borderWidth: 0.5,
        borderColor: colors.hairline,
    },
    speakerBtnActive: { backgroundColor: colors.accent, borderColor: colors.accent },
    langRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6, marginBottom: 14 },
    lang: { color: colors.accent, fontWeight: '700', fontSize: 13 },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 'auto' },
    translation: { color: colors.textPrimary, fontSize: 21, lineHeight: 30, fontWeight: '600', marginBottom: 10, letterSpacing: -0.2 },
    softError: { color: colors.textMuted, fontSize: 13, lineHeight: 18, marginBottom: 8, fontStyle: 'italic' },
    sense: { marginBottom: 8 },
    pos: { color: colors.textMuted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 3 },
    terms: { color: colors.textSecondary, fontSize: 15, lineHeight: 22 },
    sectionDivider: { height: 0.5, backgroundColor: colors.hairline, marginTop: 8, marginBottom: 14 },
    sectionLabel: { color: colors.accent, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 12 },
    dictHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
    dictName: { color: colors.textMuted, fontSize: 12, fontWeight: '600', marginBottom: 12, flexShrink: 1 },
    ctxEnglish: { color: colors.textMuted, fontSize: 15, lineHeight: 22, fontStyle: 'italic', marginBottom: 6 },
    ctxWord: { color: colors.textPrimary, fontWeight: '700', fontStyle: 'italic' },
    ctxTranslated: { color: colors.textSecondary, fontSize: 16, lineHeight: 24, marginBottom: 4 },
    meaning: { marginBottom: 12 },
    defRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
    defNum: { color: colors.textFaint, fontSize: 14, lineHeight: 21, fontWeight: '600' },
    defBody: { flex: 1 },
    defText: { color: colors.textPrimary, fontSize: 15, lineHeight: 21 },
    defExample: { color: colors.textMuted, fontSize: 14, lineHeight: 20, fontStyle: 'italic', marginTop: 3 },
    askRow: { marginTop: 14, marginBottom: 4 },
    errorText: { color: colors.danger, fontSize: 14, marginVertical: 6 },

    // Trail + phrasal verb
    trailRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 10 },
    trailText: { color: colors.textMuted, fontSize: 13, lineHeight: 18, flexShrink: 1 },
    trailBold: { color: colors.textPrimary, fontWeight: '700' },
    trailBack: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 4, paddingHorizontal: 10, borderRadius: radii.pill, backgroundColor: withAlpha(colors.accent, 0.12) },
    trailBackText: { color: colors.accent, fontSize: 13, fontWeight: '600' },
    phraseChip: {
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingVertical: 5,
        paddingHorizontal: 11,
        borderRadius: radii.pill,
        backgroundColor: withAlpha(colors.transcriptHighlight || colors.accent, colors.transcriptHighlightAlpha > 0 ? 0.22 : 0.14),
        marginBottom: 10,
    },
    phraseChipText: { color: colors.textPrimary, fontSize: 13, fontWeight: '600' },
    inlineLink: { alignSelf: 'flex-start', marginBottom: 10 },
    inlineLinkText: { color: colors.accent, fontSize: 13, fontWeight: '600' },

    // Wikipedia
    wikiHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 14, marginBottom: 8 },
    wikiTitle: { color: colors.textPrimary, fontSize: 20, lineHeight: 26, fontWeight: '700', letterSpacing: -0.2 },
    wikiDesc: { color: colors.textSecondary, fontSize: 15, lineHeight: 21, fontStyle: 'italic', marginTop: 3 },
    wikiThumb: { width: 64, height: 64, borderRadius: 12, backgroundColor: colors.hairlineFaint },
    wikiLink: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginTop: 10, marginBottom: 4 },

    // Misses / hints / chips
    missBlock: { gap: 10, marginBottom: 6 },
    missText: { color: colors.textSecondary, fontSize: 15, lineHeight: 21 },
    chipRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 10 },
    chipLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginRight: 2 },
    chip: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: radii.pill,
        backgroundColor: colors.hairlineFaint,
        borderWidth: 0.5,
        borderColor: colors.hairline,
    },
    chipText: { color: colors.accent, fontSize: 13, fontWeight: '600' },
    hintCard: {
        gap: 12,
        padding: 14,
        borderRadius: 12,
        backgroundColor: withAlpha(colors.accent, 0.07),
        borderWidth: 0.5,
        borderColor: withAlpha(colors.accent, 0.2),
    },
    hintText: { color: colors.textSecondary, fontSize: 14, lineHeight: 20 },
    hintBtn: {
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingVertical: 10,
        paddingHorizontal: 16,
        borderRadius: radii.pill,
        backgroundColor: colors.accent,
    },
    hintBtnText: { color: colors.onAccent, fontSize: 14, fontWeight: '700' },

    // Picker
    pickerRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
    pickerRowBorder: { borderBottomWidth: 0.5, borderBottomColor: colors.hairlineFaint },
    pickerName: { color: colors.textSecondary, fontSize: 16, fontWeight: '600' },
    pickerNameOn: { color: colors.textPrimary },
    pickerSub: { color: colors.textFaint, fontSize: 12, marginTop: 2 },
    pickerHas: { color: colors.success, fontSize: 12, fontWeight: '600', maxWidth: 110 },
    manageRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 14 },
    manageText: { color: colors.accent, fontSize: 14, fontWeight: '600' },

    // Footer
    actions: { flexDirection: 'row', gap: 10, paddingTop: 14 },
    actionBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingVertical: 13,
        borderRadius: radii.pill,
    },
    actionBtnGhost: { backgroundColor: colors.hairlineFaint, borderWidth: 0.5, borderColor: colors.hairline },
    selectorBtn: { flex: 1.6, paddingHorizontal: 14, justifyContent: 'flex-start' },
    selectorBtnOpen: { borderColor: withAlpha(colors.accent, 0.5), backgroundColor: withAlpha(colors.accent, 0.08) },
    selectorText: { flex: 1, color: colors.textPrimary },
    replayBtn: { flex: 1 },
    actionText: { fontSize: 14, fontWeight: '700' },
});

export default WordPopover;
