/**
 * What an episode names (5.5.0).
 *
 * A podcast hour is full of things worth looking up — a novel, the film of
 * the novel, a record, a town, the historian who wrote the book they are all
 * arguing about — and until now the app could only find two of them: titles
 * by their shape (services/bookText.js) and people the episode's own notes
 * already spelled (services/nameIndex.js). Both decide what a thing is while
 * looking at a few words, which is how "Cairo" ends up as a city in a
 * programme about Constantine's chi-rho.
 *
 * The model has read the whole episode, so it does the identifying — once,
 * for every kind at the same time, because the ambiguity is between kinds:
 * "Dune" is a novel or a film depending on the sentence, and one pass sees
 * both readings where six passes each see one. For each mention it returns
 * the words the recogniser wrote, what the thing is really called, its kind,
 * and a `hint` — the author, the year, the country the episode itself gave.
 *
 * Then a catalogue confirms it, and the hint is what the catalogue is asked
 * with: Goodreads for a book, TMDB for a film or a programme, Apple for a
 * record, Wikipedia for a person or a place. The model proposes and the
 * catalogue disposes — nothing the model merely believes is shown as fact,
 * and a mention whose words are not in the transcript is dropped, the same
 * rule the assistant's corrections live by.
 */
import { getEpisodeById, recordApiSpend, replaceEpisodeEntities } from '../database/queries';
import { acceptPhrases, PHRASE_INSTRUCTIONS, PHRASE_SCHEMA } from './phraseIndex';
import { assistantRequest, costOf, episodeNotes, episodeParts, getOpenAIKey, isAutoTagOn } from './aiService';
import { getCorrectedTranscript } from './nameIndex';
import { countPhrase } from './nameText';
import { searchGoodreads } from '../api/goodreads';
import { searchOpenLibraryByTitle } from '../api/openLibrary';
import { searchITunes } from '../api/itunes';
import { getTmdbKey, searchTmdb } from '../api/tmdb';
import { fetchWikipediaSummary, isListPage, searchWikipediaTitles } from '../api/wikipedia';
import { notifyLibraryChange } from './libraryEvents';
import { log } from './logService';

export const ENTITY_TYPES = ['person', 'place', 'book', 'film', 'tv', 'podcast', 'album'];
export const TYPE_LABEL = {
    person: 'Person', place: 'Place', book: 'Book', film: 'Film', tv: 'Television', podcast: 'Podcast', album: 'Record',
};
export const TYPE_ICON = {
    person: 'user', place: 'map-pin', book: 'book', film: 'film', tv: 'tv', podcast: 'mic', album: 'disc',
};

const MAX_PER_PART = 40;
const RESOLVE_AT_ONCE = 4;

const INSTRUCTIONS = `You list what a podcast episode names: the people, places, books, films, television programmes, other podcasts and records its speakers talk about, from an automatic transcript with one sentence per line.

For each one give:
- "surface": the words exactly as the transcript has them, copied character for character, at most six words. Where the transcript spells it several ways, use the first.
- "canonical": what the thing is really called, spelled properly.
- "type": one of person, place, book, film, tv, podcast, album. A podcast is a podcast, not television, even when it is only trailed.
- "hint": what this episode says about it, in a few words — an author, a year, a director, a country, a role. This is what tells one thing of the same name from another, so write what would let a librarian pick the right one: "the 1965 Herbert novel", "the Roman emperor", "Villeneuve's adaptation".
- "context": the transcript line it appears in, copied as written.

Include what the speakers name and actually talk about. Leave out the presenter, the guests and the programme itself; a place named only to locate another place; a figure of speech; anything you cannot point to in the text. A recogniser misspelling belongs in "surface" with the true spelling in "canonical" — that pairing is the point of the list.

At most ${MAX_PER_PART} for this text, the ones a listener might want to look up. Cover every kind that appears — a programme or a record named once still belongs on the list — rather than listing more of one kind. Return an empty list when there is nothing worth listing.

${PHRASE_INSTRUCTIONS}`;

const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['entities', 'phrases'],
    properties: {
        phrases: PHRASE_SCHEMA,
        entities: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['surface', 'canonical', 'type', 'hint', 'context'],
                properties: {
                    surface: { type: 'string' },
                    canonical: { type: 'string' },
                    type: { type: 'string', enum: ENTITY_TYPES },
                    hint: { type: 'string' },
                    context: { type: 'string' },
                },
            },
        },
    },
};

const YEAR = /\b(1[5-9]\d{2}|20\d{2})\b/;
const trim = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Where a mention is, or nothing at all. The words have to be in the
 * transcript — that is the whole guarantee — but a model asked for the
 * spelling it heard will sometimes hand back the spelling it knows, so the
 * canonical name is tried before giving up. When the line it quoted is
 * findable, that is where the mention is: "Constantine" is said ninety-six
 * times in an hour and only one of them is the film.
 */
const locate = (rows, surface, canonical, context) => {
    let heard = surface;
    let hit = countPhrase(rows, surface);
    if (!hit.count && canonical.toLowerCase() !== surface.toLowerCase()) {
        hit = countPhrase(rows, canonical);
        if (hit.count) heard = canonical;
    }
    if (!hit.count) return null;
    // The quoted line is the recogniser's, but the model retypes it and a
    // word drifts, so the opening is tried at shrinking lengths.
    const words = String(context || '').split(/\s+/).filter(Boolean);
    for (const n of [8, 6, 4]) {
        if (words.length < n) continue;
        const line = countPhrase(rows, words.slice(0, n).join(' '));
        if (line.count) return { heard, count: hit.count, firstMs: line.firstMs };
    }
    return { heard, count: hit.count, firstMs: hit.firstMs };
};

/** The mentions the transcript can vouch for, deduplicated. */
const accept = (raw, rows) => {
    const kept = [];
    const seen = new Set();
    for (const e of raw || []) {
        const surface = trim(e.surface, 80);
        const canonical = trim(e.canonical, 120) || surface;
        if (!surface || !ENTITY_TYPES.includes(e.type)) continue;
        const key = `${e.type}|${canonical.toLowerCase()}`;
        if (seen.has(key)) continue;
        const where = locate(rows, surface, canonical, e.context);
        if (!where) continue;                       // not in the text: dropped
        seen.add(key);
        // The words around a mention outrank the model's guess at its kind: a
        // show introduced as "the podcast Gone Medieval" is a podcast, however
        // much it is trailed like television (user: "gone medieval is a
        // podcast a continues match like a television").
        let type = e.type;
        if ((type === 'tv' || type === 'album') && /\bpodcasts?\b/i.test(`${e.hint} ${e.context}`)) type = 'podcast';
        kept.push({
            type, surface: where.heard, canonical,
            hint: trim(e.hint, 200), context: trim(e.context, 400),
            count: where.count, firstMs: where.firstMs,
        });
    }
    return kept;
};

// ─── Catalogues ──────────────────────────────────────────────────────────────

// Words from the episode's own hint that a page about the right thing would
// use. Without this the lookup is a bare title, and a bare title is how
// "Stern" the dealer becomes the back of a boat and "Mango" a fruit.
const HINT_STOP = new Set([
    'this', 'that', 'they', 'them', 'their', 'there', 'then', 'with', 'from', 'about', 'into', 'over',
    'episode', 'programme', 'show', 'said', 'says', 'called', 'known', 'mentioned', 'talks', 'talked',
    'discussed', 'presenter', 'guest', 'host', 'also', 'more', 'much', 'very', 'what', 'when', 'where',
    'which', 'who', 'whom', 'been', 'being', 'have', 'has', 'had', 'the',
]);
const hintWords = (hint) => [...new Set(String(hint || '').toLowerCase().match(/[a-z]{4,}/g) || [])]
    .filter(w => !HINT_STOP.has(w));

/** True when the page looks like the thing the episode was talking about. */
const agrees = (page, hint) => {
    const words = hintWords(hint);
    if (!words.length) return true;                 // nothing to check it against
    const hay = `${page.description || ''} ${page.extract || ''}`.toLowerCase();
    return words.some(w => hay.includes(w.slice(0, Math.max(4, w.length - 2))));
};

// What a page about a person, or a place, says about itself. "Stern" the
// ship's back and "Mango" the fruit fail these; Naissus the city passes.
const KIND_MARKERS = {
    person: /\b(emperor|empress|king|queen|prince|princess|pharaoh|caliph|sultan|tsar|shah|chief|duke|duchess|earl|count|countess|baron|baroness|lord|lady|knight|noble|nobleman|noblewoman|saint|bishop|archbishop|cardinal|pope|monk|nun|priest|priestess|abbot|rabbi|imam|prophet|apostle|martyr|preacher|theologian|missionary|god|goddess|deity|deities|divinity|mythology|mythological|legendary|hero|heroine|titan|nymph|politician|president|minister|senator|governor|mayor|chancellor|ambassador|diplomat|statesman|leader|ruler|founder|figure|activist|revolutionary|rebel|general|admiral|commander|officer|soldier|consul|caesar|tribune|actor|actress|comedian|presenter|broadcaster|host|journalist|author|writer|novelist|poet|playwright|historian|philosopher|scholar|scientist|physicist|chemist|biologist|mathematician|astronomer|economist|engineer|architect|inventor|explorer|painter|sculptor|artist|composer|musician|singer|rapper|dancer|footballer|cricketer|athlete|boxer|player|manager|coach|businessman|businesswoman|entrepreneur|executive|banker|lawyer|judge|physician|surgeon|doctor|teacher|professor|criminal|hacker|spy|born|died|\d{3,4}\s*[\u2013-]\s*(?:c\.\s*)?\d{3,4})\b/i,
    place: /\b(city|town|village|capital|country|region|province|county|state|island|river|bridge|mountain|lake|sea|district|municipality|settlement|kingdom|empire|colony|site|ruins|castle|cathedral|church|palace|square|street)\b/i,
};
const looksLike = (page, type) => {
    const re = KIND_MARKERS[type];
    return !re || re.test(`${page.description || ''} ${String(page.extract || '').slice(0, 400)}`);
};

// A title without its bracketed qualifier: "Constantine (film)" and the
// model's "Constantine (2005 film)" are the same name, and the comparison
// below must see that they are.
const bareTitle = (t) => String(t || '').toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').trim();

const fromWikipedia = async (entity, signal) => {
    const wanted = bareTitle(entity.canonical);
    const summary = async (title) => {
        const page = await fetchWikipediaSummary(title, 'en', signal).catch(() => null);
        // A disambiguation page is not an answer — it is the question again;
        // nor is a list ("Fausta" → a page of everyone called Fausta).
        return page && !isListPage(page) && looksLike(page, entity.type) ? page : null;
    };

    // The article of that exact name, when the episode's hint fits it.
    const exact = await summary(entity.canonical);
    let page = exact && agrees(exact, entity.hint) ? exact : null;

    // Otherwise what Wikipedia's search makes of the name and the hint
    // together — but only a hit that carries the name it was searched for:
    // "Naissus, Constantine's birthplace" must not become Helena's article
    // because Helena's article says "Constantine".
    if (!page) {
        const titles = await searchWikipediaTitles(`${entity.canonical} ${entity.hint}`.trim(), { limit: 5, signal })
            .catch(() => []);
        for (const title of titles) {
            if (String(title).toLowerCase() === entity.canonical.toLowerCase()) continue;   // already tried
            const t = bareTitle(title);
            if (!(t.includes(wanted) || wanted.includes(t))) continue;
            const candidate = await summary(title);
            if (candidate && agrees(candidate, entity.hint)) { page = candidate; break; }
        }
    }

    // Failing both, the exact article stands on its own when it is plainly
    // the right kind of thing — a city is a city whatever the hint said.
    if (!page && exact) page = exact;
    if (!page) return null;
    return {
        source: 'wikipedia',
        sourceUrl: page.url || `https://en.wikipedia.org/wiki/${encodeURIComponent(String(page.title).replace(/ /g, '_'))}`,
        // The summary's own thumbnail: about 330 px, already rendered and
        // cached. Asking for another width gets HTTP 400 from thumb.wikimedia.org
        // (2026-09-22), which is why nine of eleven emperors had no face.
        imageUrl: page.thumbnail?.uri || null,
        subtitle: page.description || '',
        blurb: page.extract || '',
    };
};

// A title alone is not enough for a book: "Chi Rho" the symbol has a thriller
// of the same name on Goodreads. The match must name an author the episode
// itself said — in the hint, the quoted line or anywhere in the transcript.
const surname = (author) => {
    const parts = String(author || '').toLowerCase().replace(/[^\p{L}\s'-]/gu, '').trim().split(/\s+/);
    const last = parts[parts.length - 1] || '';
    return last.length >= 3 ? last : '';
};
const authorWasSaid = (author, entity, said) => {
    const last = surname(author);
    return !!last && `${entity.hint} ${entity.context} ${said}`.toLowerCase().includes(last);
};

const fromGoodreads = async (entity, said, signal) => {
    const hits = await searchGoodreads(entity.canonical, signal).catch(() => []);
    const best = hits.find(h => authorWasSaid(h.author, entity, said));
    if (!best) return null;
    return {
        source: 'goodreads',
        sourceUrl: best.url,
        imageUrl: best.coverUrl,
        subtitle: best.author ? `by ${best.author}` : '',
        facts: best.pages ? `${best.pages} pages` : '',
        blurb: best.description,
        rating: best.rating,
        ratingsCount: best.ratingsCount,
    };
};

const fromOpenLibrary = async (entity, said, signal) => {
    const docs = await searchOpenLibraryByTitle(entity.canonical, signal, { limit: 5 }).catch(() => []);
    const firstAuthor = (d) => (Array.isArray(d?.author_name) ? d.author_name[0] : d?.author_name);
    const best = (Array.isArray(docs) ? docs : []).find(d => authorWasSaid(firstAuthor(d), entity, said));
    if (!best) return null;
    const author = firstAuthor(best);
    return {
        source: 'openlibrary',
        sourceUrl: best.key ? `https://openlibrary.org${best.key}` : null,
        imageUrl: best.cover_i ? `https://covers.openlibrary.org/b/id/${best.cover_i}-L.jpg` : null,
        subtitle: author ? `by ${author}` : '',
        facts: best.first_publish_year ? String(best.first_publish_year) : '',
    };
};

const APPLE_ENTITY = { album: 'album', tv: 'tvSeason', podcast: 'podcast' };
const APPLE_SOURCE = { album: 'applemusic', tv: 'appletv', podcast: 'applepodcasts' };

const fromITunes = async (entity, kind, signal) => {
    const term = kind === 'album' && entity.hint
        ? `${entity.canonical} ${entity.hint.split(/[,;(]/)[0]}`.trim()
        : entity.canonical;
    const apple = APPLE_ENTITY[kind];
    let best = null;
    for (const country of ['GB', 'US']) {           // the podcasts are mostly British
        const hits = await searchITunes(term, apple, { country, signal }).catch(() => []);
        best = hits.find(h => h.title.toLowerCase().startsWith(entity.canonical.toLowerCase().slice(0, 12))) || hits[0];
        if (best) break;
    }
    if (!best) return null;
    const sameName = best.subtitle && best.subtitle.toLowerCase() === best.title.replace(/,?\s*(?:season|series) \d+.*$/i, '').toLowerCase();
    return {
        source: APPLE_SOURCE[kind],
        sourceUrl: best.url,
        imageUrl: best.imageUrl,
        subtitle: kind === 'album' ? best.subtitle : (sameName ? '' : best.subtitle),
        facts: [kind === 'podcast' ? '' : best.year, best.genre,
            best.tracks && kind !== 'podcast' ? `${best.tracks} ${kind === 'album' ? 'tracks' : 'episodes'}` : '']
            .filter(Boolean).join(' \u00b7 '),
        blurb: best.blurb,
    };
};

const fromTmdb = async (entity, kind, apiKey, signal) => {
    const m = YEAR.exec(entity.hint);
    const hit = await searchTmdb(kind, entity.canonical, { year: m ? Number(m[1]) : null, apiKey, signal })
        .catch(() => null);
    if (!hit) return null;
    return {
        source: 'tmdb',
        sourceUrl: hit.imdbUrl || hit.url,
        imageUrl: hit.imageUrl,
        subtitle: hit.subtitle,
        facts: hit.year ? String(hit.year) : '',
        blurb: hit.blurb,
        rating: hit.rating,
        ratingsCount: hit.ratingsCount,
    };
};

/**
 * One entity's catalogue answer, or null. Each kind goes where that kind is
 * catalogued, and falls back to Wikipedia, which knows nearly everything
 * without knowing what it looks like.
 */
export const resolveEntity = async (entity, { tmdbKey = '', said = '', signal } = {}) => {
    try {
        if (entity.type === 'book') {
            return (await fromGoodreads(entity, said, signal))
                || (await fromOpenLibrary(entity, said, signal))
                || (await fromWikipedia(entity, signal));
        }
        if (entity.type === 'album') {
            return (await fromITunes(entity, 'album', signal)) || (await fromWikipedia(entity, signal));
        }
        if (entity.type === 'podcast') {
            return (await fromITunes(entity, 'podcast', signal)) || (await fromWikipedia(entity, signal));
        }
        if (entity.type === 'tv') {
            const screen = (tmdbKey ? await fromTmdb(entity, 'tv', tmdbKey, signal) : null)
                || (await fromITunes(entity, 'tv', signal))
                || (await fromWikipedia(entity, signal));
            if (screen) return screen;
            // Known to no screen catalogue and not to Wikipedia either, but on
            // Apple Podcasts: the model called a podcast television, and the
            // answer carries the corrected kind. Wikipedia has to come first —
            // "Live at the Apollo" is a BBC programme Apple TV does not list
            // and a podcast Apple does, and only the encyclopaedia knows which
            // one the comedian was on.
            const pod = await fromITunes(entity, 'podcast', signal);
            if (pod) return { ...pod, type: 'podcast' };
            return null;
        }
        if (entity.type === 'film') {
            return (tmdbKey ? await fromTmdb(entity, 'movie', tmdbKey, signal) : null)
                || (await fromWikipedia(entity, signal));
        }
        return await fromWikipedia(entity, signal);
    } catch (e) {
        if (e?.name === 'AbortError') throw e;
        return null;
    }
};

// ─── The pass ────────────────────────────────────────────────────────────────

const _running = new Map();

export const isIndexingEntities = (episodeId) => _running.has(episodeId);

/**
 * The pass at the end of a transcription, when the listener switched it on
 * (Settings → Episode assistant → tag after every transcription). Resolves
 * to the pass's answer, or null when the switch is off, there is no key, or
 * the run failed — the sheet in the Player offers it again either way.
 */
export const willTagAuto = async () => (await isAutoTagOn()) && !!(await getOpenAIKey());

export const tagIfAuto = async (episodeId) => {
    if (!(await willTagAuto())) return null;
    try {
        return await indexEpisodeEntities(episodeId);
    } catch (e) {
        log('SERVICE', 'Automatic entity scan failed', { id: episodeId, error: e?.message || String(e) });
        return null;
    }
};

/**
 * Finds what the episode names and looks each one up. Resolves
 * { found, resolved, cost }; rejects with `kind` 'nokey' or 'notranscript'
 * when there is nothing to work with. Two callers share one run.
 */
export const indexEpisodeEntities = (episodeId, { request, model, onProgress = () => {} } = {}) => {
    const active = _running.get(episodeId);
    if (active) return active;
    const p = (async () => {
        const t0 = Date.now();
        const ep = await getEpisodeById(episodeId);
        if (!ep) throw Object.assign(new Error('This episode is gone.'), { kind: 'notranscript' });
        const rows = await getCorrectedTranscript(episodeId);
        if (!rows.length) throw Object.assign(new Error('This episode has no transcript yet.'), { kind: 'notranscript' });

        let ask = request;
        let modelId = model;
        if (!ask) ({ request: ask, model: modelId } = await assistantRequest());

        const notes = episodeNotes(ep);
        const { head, parts } = episodeParts(ep, rows, notes);
        const usage = { input: 0, output: 0, cached: 0 };
        const raw = [];
        const rawPhrases = [];
        for (let i = 0; i < parts.length; i++) {
            const r = await ask({
                instructions: INSTRUCTIONS, schemaName: 'episode_entities', schema: SCHEMA,
                input: `${head}\n\nTranscript:\n${parts[i].join('\n')}`,
                maxOutputTokens: 12000,
            });
            usage.input += r.usage?.input || 0;
            usage.output += r.usage?.output || 0;
            usage.cached += r.usage?.cached || 0;
            raw.push(...(r.json?.entities || []));
            rawPhrases.push(...(r.json?.phrases || []));
            onProgress(Math.round((i + 1) / (parts.length + 1) * 100));
        }
        const entities = accept(raw, rows);
        const phrases = acceptPhrases(rawPhrases, rows);

        // The catalogues, a few at a time so none of them is hammered.
        const tmdbKey = await getTmdbKey();
        const said = rows.map(r => String(r.text || '')).join(' ').toLowerCase();
        let resolved = 0;
        for (let i = 0; i < entities.length; i += RESOLVE_AT_ONCE) {
            const block = entities.slice(i, i + RESOLVE_AT_ONCE);
            await Promise.all(block.map(async (e) => {
                const r = await resolveEntity(e, { tmdbKey, said });
                if (r) { Object.assign(e, r, { resolvedAt: Date.now() }); resolved += 1; }
                else e.resolvedAt = Date.now();
            }));
            onProgress(Math.round((parts.length + (i + block.length) / Math.max(1, entities.length)) / (parts.length + 1) * 100));
        }

        await replaceEpisodeEntities(episodeId, entities, phrases);
        const cost = modelId ? costOf(modelId, usage) : 0;
        await recordApiSpend({
            provider: 'openai', service: 'entities', model: modelId, episodeId, episodeTitle: ep.title,
            tokensIn: usage.input, tokensCached: usage.cached, tokensOut: usage.output, cost,
        });
        log('SERVICE', 'Entity scan finished', {
            id: episodeId, title: ep.title, model: modelId, parts: parts.length,
            proposed: raw.length, kept: entities.length, resolved,
            phrasal: phrases.filter(p => p.kind === 'phrasal').length,
            idioms: phrases.filter(p => p.kind === 'idiom').length,
            phrasesProposed: rawPhrases.length,
            byType: ENTITY_TYPES.map(t => `${t}:${entities.filter(e => e.type === t).length}`).join(' '),
            tokensIn: usage.input, tokensOut: usage.output, cost: `$${cost.toFixed(4)}`, ms: Date.now() - t0,
        });
        try { notifyLibraryChange({ type: 'entities-indexed', episodeId, count: entities.length, phrases: phrases.length }); } catch (_) {}
        return { found: entities.length, resolved, phrases: phrases.length, cost };
    })().finally(() => { _running.delete(episodeId); });
    _running.set(episodeId, p);
    return p;
};
