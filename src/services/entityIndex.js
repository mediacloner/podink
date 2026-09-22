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
import { assistantRequest, costOf, episodeNotes, episodeParts } from './aiService';
import { getCorrectedTranscript } from './nameIndex';
import { countPhrase } from './nameText';
import { searchGoodreads } from '../api/goodreads';
import { searchOpenLibraryByTitle } from '../api/openLibrary';
import { searchITunes } from '../api/itunes';
import { getTmdbKey, searchTmdb } from '../api/tmdb';
import { fetchWikipediaSummary, lookupWikipedia } from '../api/wikipedia';
import { notifyLibraryChange } from './libraryEvents';
import { log } from './logService';

export const ENTITY_TYPES = ['person', 'place', 'book', 'film', 'tv', 'album'];
export const TYPE_LABEL = {
    person: 'Person', place: 'Place', book: 'Book', film: 'Film', tv: 'Television', album: 'Record',
};
export const TYPE_ICON = {
    person: 'user', place: 'map-pin', book: 'book', film: 'film', tv: 'tv', album: 'disc',
};

const MAX_PER_PART = 25;
const RESOLVE_AT_ONCE = 4;

const INSTRUCTIONS = `You list what a podcast episode names: the people, places, books, films, television programmes and records its speakers talk about, from an automatic transcript with one sentence per line.

For each one give:
- "surface": the words exactly as the transcript has them, copied character for character, at most six words. Where the transcript spells it several ways, use the first.
- "canonical": what the thing is really called, spelled properly.
- "type": one of person, place, book, film, tv, album.
- "hint": what this episode says about it, in a few words — an author, a year, a director, a country, a role. This is what tells one thing of the same name from another, so write what would let a librarian pick the right one: "the 1965 Herbert novel", "the Roman emperor", "Villeneuve's adaptation".
- "context": the transcript line it appears in, copied as written.

Include what the speakers name and actually talk about. Leave out the presenter, the guests and the programme itself; a place named only to locate another place; a figure of speech; anything you cannot point to in the text. A recogniser misspelling belongs in "surface" with the true spelling in "canonical" — that pairing is the point of the list.

At most ${MAX_PER_PART} for this text, the ones a listener might want to look up. Return an empty list when there is nothing worth listing.`;

const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['entities'],
    properties: {
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
        kept.push({
            type: e.type, surface: where.heard, canonical,
            hint: trim(e.hint, 200), context: trim(e.context, 400),
            count: where.count, firstMs: where.firstMs,
        });
    }
    return kept;
};

// ─── Catalogues ──────────────────────────────────────────────────────────────

const fromWikipedia = async (entity, signal) => {
    const page = await lookupWikipedia([entity.canonical, entity.surface], { signal })
        || await fetchWikipediaSummary(entity.canonical, 'en', signal);
    if (!page) return null;
    return {
        source: 'wikipedia',
        sourceUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(page.title).replace(/ /g, '_'))}`,
        imageUrl: page.original?.uri || page.thumbnail?.uri || null,
        subtitle: page.description || '',
        blurb: page.extract || '',
    };
};

const fromGoodreads = async (entity, signal) => {
    const hits = await searchGoodreads(entity.canonical, signal).catch(() => []);
    const hint = entity.hint.toLowerCase();
    const best = hits.find(h => h.author && hint.includes(h.author.split(' ').pop().toLowerCase())) || hits[0];
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

const fromOpenLibrary = async (entity, signal) => {
    const docs = await searchOpenLibraryByTitle(entity.canonical, signal, { limit: 5 }).catch(() => []);
    const best = Array.isArray(docs) ? docs[0] : null;
    if (!best) return null;
    const author = Array.isArray(best.author_name) ? best.author_name[0] : best.author_name;
    return {
        source: 'openlibrary',
        sourceUrl: best.key ? `https://openlibrary.org${best.key}` : null,
        imageUrl: best.cover_i ? `https://covers.openlibrary.org/b/id/${best.cover_i}-L.jpg` : null,
        subtitle: author ? `by ${author}` : '',
        facts: best.first_publish_year ? String(best.first_publish_year) : '',
    };
};

const fromITunes = async (entity, kind, signal) => {
    const term = kind === 'album' && entity.hint
        ? `${entity.canonical} ${entity.hint.split(/[,;(]/)[0]}`.trim()
        : entity.canonical;
    const hits = await searchITunes(term, kind === 'album' ? 'album' : 'tvSeason', { signal }).catch(() => []);
    const best = hits[0];
    if (!best) return null;
    return {
        source: kind === 'album' ? 'applemusic' : 'appletv',
        sourceUrl: best.url,
        imageUrl: best.imageUrl,
        subtitle: best.subtitle,
        facts: [best.year, best.genre, best.tracks ? `${best.tracks} tracks` : ''].filter(Boolean).join(' · '),
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
export const resolveEntity = async (entity, { tmdbKey = '', signal } = {}) => {
    try {
        if (entity.type === 'book') {
            return (await fromGoodreads(entity, signal))
                || (await fromOpenLibrary(entity, signal))
                || (await fromWikipedia(entity, signal));
        }
        if (entity.type === 'album') {
            return (await fromITunes(entity, 'album', signal)) || (await fromWikipedia(entity, signal));
        }
        if (entity.type === 'tv') {
            return (tmdbKey ? await fromTmdb(entity, 'tv', tmdbKey, signal) : null)
                || (await fromITunes(entity, 'tv', signal))
                || (await fromWikipedia(entity, signal));
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
        for (let i = 0; i < parts.length; i++) {
            const r = await ask({
                instructions: INSTRUCTIONS, schemaName: 'episode_entities', schema: SCHEMA,
                input: `${head}\n\nTranscript:\n${parts[i].join('\n')}`,
                maxOutputTokens: 4000,
            });
            usage.input += r.usage?.input || 0;
            usage.output += r.usage?.output || 0;
            usage.cached += r.usage?.cached || 0;
            raw.push(...(r.json?.entities || []));
            onProgress(Math.round((i + 1) / (parts.length + 1) * 100));
        }
        const entities = accept(raw, rows);

        // The catalogues, a few at a time so none of them is hammered.
        const tmdbKey = await getTmdbKey();
        let resolved = 0;
        for (let i = 0; i < entities.length; i += RESOLVE_AT_ONCE) {
            const block = entities.slice(i, i + RESOLVE_AT_ONCE);
            await Promise.all(block.map(async (e) => {
                const r = await resolveEntity(e, { tmdbKey });
                if (r) { Object.assign(e, r, { resolvedAt: Date.now() }); resolved += 1; }
                else e.resolvedAt = Date.now();
            }));
            onProgress(Math.round((parts.length + (i + block.length) / Math.max(1, entities.length)) / (parts.length + 1) * 100));
        }

        await replaceEpisodeEntities(episodeId, entities);
        const cost = modelId ? costOf(modelId, usage) : 0;
        await recordApiSpend({
            provider: 'openai', service: 'entities', model: modelId, episodeId, episodeTitle: ep.title,
            tokensIn: usage.input, tokensCached: usage.cached, tokensOut: usage.output, cost,
        });
        log('SERVICE', 'Entity scan finished', {
            id: episodeId, title: ep.title, model: modelId, parts: parts.length,
            proposed: raw.length, kept: entities.length, resolved,
            byType: ENTITY_TYPES.map(t => `${t}:${entities.filter(e => e.type === t).length}`).join(' '),
            tokensIn: usage.input, tokensOut: usage.output, cost: `$${cost.toFixed(4)}`, ms: Date.now() - t0,
        });
        try { notifyLibraryChange({ type: 'entities-indexed', episodeId, count: entities.length }); } catch (_) {}
        return { found: entities.length, resolved, cost };
    })().finally(() => { _running.delete(episodeId); });
    _running.set(episodeId, p);
    return p;
};
