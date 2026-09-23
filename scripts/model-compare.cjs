#!/usr/bin/env node
/**
 * Runs the app's own OpenAI passes over one episode with two or more models
 * and puts the answers side by side — the real check of whether a new model
 * suits what this app asks of one (a table of contents, verified
 * corrections, punctuation that keeps every word, what the episode names,
 * translation with context), which no published benchmark measures.
 *
 * The passes are the app's functions, loaded from src/ through Babel with
 * the phone-only modules (SQLite, AsyncStorage, the catalogues) replaced:
 * the same prompts, schemas, part splitting, snapping and acceptance rules
 * the phone runs. Every model reads the same rows — the recogniser's own
 * text with the names pass applied, no corrections from an earlier run.
 * Nothing is written anywhere but the JSON report.
 *
 *   OPENAI_API_KEY=sk-… node scripts/model-compare.cjs --db Podink.db --list
 *   OPENAI_API_KEY=sk-… node scripts/model-compare.cjs --db Podink.db --episode "Constantine" \
 *        [--models gpt-5.6-luna,gpt-6-luna] [--passes assistant,punctuation,entities,translation] \
 *        [--lang es] [--effort low] [--out report.json]
 *
 * The database is the phone's (see the memory note on reading it off a
 * release build). Costs are the models' list prices; an hour of audio is a
 * cent or two on Luna and twenty-odd on Sol.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const babel = require('@babel/core');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const src = (p) => path.join(ROOT, 'src', p);

// Prices per million tokens (OpenAI's page, 2026-09-23); cached input is a tenth.
const PRICES = {
    'gpt-5.6-luna': [0.20, 1.20], 'gpt-5.6-terra': [2.00, 12.00], 'gpt-5.6-sol': [4.00, 20.00],
    'gpt-6-luna': [0.10, 0.50], 'gpt-6-sol': [2.00, 10.00], 'gpt-6-astra': [10.00, 50.00],
};
const dollars = (model, u) => {
    const [i, o] = PRICES[model] || [0, 0];
    const cached = u.cached || 0;
    return ((u.input - cached) * i + cached * i * 0.1 + u.output * o) / 1e6;
};

// ─── Arguments ───────────────────────────────────────────────────────────────

const parseArgs = (argv) => {
    const a = { models: 'gpt-5.6-luna,gpt-6-luna', passes: 'assistant,punctuation,entities,translation', lang: 'es' };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (!k.startsWith('--')) continue;
        const name = k.slice(2);
        if (name === 'list') { a.list = true; continue; }
        a[name] = argv[++i];
    }
    return a;
};

// ─── Loading src/ in Node ────────────────────────────────────────────────────
// Relative imports load the real file; anything the phone provides is mocked.

const makeLoader = (mocks) => {
    const cache = new Map();
    const resolveFile = (from, spec) => {
        const base = path.resolve(path.dirname(from), spec);
        for (const c of [base, `${base}.js`, path.join(base, 'index.js')]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
        throw new Error(`Cannot resolve ${spec} from ${from}`);
    };
    const load = (file) => {
        if (mocks[file]) return mocks[file];
        if (cache.has(file)) return cache.get(file).exports;
        const module = { exports: {} };
        cache.set(file, module);
        const { code } = babel.transformSync(fs.readFileSync(file, 'utf8'), {
            configFile: false, babelrc: false, filename: file,
            plugins: [require.resolve('@babel/plugin-transform-modules-commonjs'), require.resolve('@babel/plugin-transform-react-jsx')],
        });
        const fn = vm.runInThisContext(`(function (exports, require, module, __filename, __dirname) {${code}\n})`, { filename: file });
        const req = (spec) => {
            if (spec.startsWith('.')) return load(resolveFile(file, spec));
            if (spec in mocks) return mocks[spec];
            throw new Error(`Unexpected dependency ${spec} from ${path.relative(ROOT, file)}`);
        };
        fn(module.exports, req, module, file, path.dirname(file));
        return module.exports;
    };
    return load;
};

// ─── The database, read only ─────────────────────────────────────────────────

const openDb = (file) => {
    if (!file || !fs.existsSync(file)) throw new Error(`No database at ${file || '(none given)'} — pass --db Podink.db`);
    return new DatabaseSync(file);
};
const hasTable = (db, name) => !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
const episodesWithTranscripts = (db) => db.prepare(
    `SELECT e.id, e.title, e.podcast_title, e.duration,
            (SELECT COUNT(*) FROM Transcripts t WHERE t.episode_id = e.id) AS rows_n
       FROM Episodes e WHERE rows_n > 0 ORDER BY rows_n DESC`).all();
// The recogniser's own words: text_fixed (an earlier punctuation run) is left out
// so every model starts from the same text.
const transcriptRows = (db, id) => db.prepare(
    `SELECT id, episode_id, start_time, end_time, text, text AS text_raw
       FROM Transcripts WHERE episode_id = ? ORDER BY start_time ASC`).all(id);
const episodeNames = (db, id) => hasTable(db, 'EpisodeNames')
    ? db.prepare(`SELECT heard, canonical, count, first_ms FROM EpisodeNames WHERE episode_id = ? ORDER BY count DESC, heard ASC`).all(id)
    : [];

const pickEpisode = (db, wanted) => {
    const all = episodesWithTranscripts(db);
    const byId = all.find(e => e.id === wanted);
    if (byId) return byId;
    const hits = all.filter(e => String(e.title || '').toLowerCase().includes(String(wanted || '').toLowerCase()));
    if (hits.length === 1) return hits[0];
    if (!hits.length) throw new Error(`No transcribed episode matches "${wanted}" — try --list`);
    throw new Error(`"${wanted}" matches ${hits.length} episodes:\n${hits.map(e => `  ${e.id}  ${e.title}`).join('\n')}`);
};

// ─── One model, every pass ───────────────────────────────────────────────────

const sentenceCount = (s) => (String(s || '').match(/[.!?](\s|$)/g) || []).length;
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const parseClock = (s) => {
    const m = String(s || '').trim().match(/^\[?(?:(\d+):)?(\d{1,2}):(\d{2})\]?$/);
    return m ? ((+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000 : null;
};

const runModel = async ({ model, ep, db, apiKey, passes, lang, effort, fetchImpl, say }) => {
    const calls = [];          // every request to OpenAI, from the fetch wrapper
    const logs = [];
    const captured = { analysis: null, repunctuation: [], entities: null };
    const rows = transcriptRows(db, ep.id);
    const names = episodeNames(db, ep.id);

    const store = { '@openai_api_key': apiKey, '@ai_model': model, '@ai_fix_transcript': '1' };
    const AsyncStorage = { getItem: async (k) => store[k] ?? null, setItem: async (k, v) => { store[k] = v; }, removeItem: async (k) => { delete store[k]; } };
    const queries = {
        getEpisodeById: async (id) => db.prepare(`SELECT * FROM Episodes WHERE id = ?`).get(id) || null,
        getTranscriptsForEpisode: async (id) => transcriptRows(db, id),
        getEpisodeNames: async (id) => episodeNames(db, id),
        getEpisodeFixes: async () => [],                        // no earlier run's corrections leak in
        isRadioFeedUrl: () => false,
        recordApiSpend: async () => {},
        replaceEpisodeAnalysis: async (id, a) => { captured.analysis = a; },
        saveRepunctuation: async (id, updates) => { captured.repunctuation.push(...updates); },
        replaceEpisodeEntities: async (id, entities) => { captured.entities = entities; },
        replaceEpisodeNames: async () => {},
        markEpisodeNamesIndexed: async () => {},
    };
    const nothing = async () => [];
    const mocks = {
        '@react-native-async-storage/async-storage': AsyncStorage,
        '@react-native-community/netinfo': { fetch: async () => ({ isConnected: true }) },
        'react-native': { Platform: { OS: 'test' }, NativeModules: {} },
        [src('database/queries.js')]: queries,
        [src('services/logService.js')]: { log: (level, msg, data) => logs.push({ level, msg, data }) },
        [src('services/libraryEvents.js')]: { notifyLibraryChange() {} },
        [src('services/bookIndex.js')]: { indexEpisodeBooks: async () => null },
        [src('components/transcript/translate.js')]: { langEnglishName: (c) => LANGS[c] || String(c || '').toUpperCase() },
        // The catalogues are the same for every model; what differs is what
        // the model proposes, so the lookups are switched off here.
        [src('api/goodreads.js')]: { searchGoodreads: nothing },
        [src('api/openLibrary.js')]: { searchOpenLibraryByTitle: nothing, searchOpenLibraryByAuthor: nothing, fetchOpenLibraryDescription: async () => null },
        [src('api/itunes.js')]: { searchITunes: nothing },
        [src('api/tmdb.js')]: { getTmdbKey: async () => '', searchTmdb: nothing },
        [src('api/wikipedia.js')]: { fetchWikipediaSummary: async () => null, isListPage: () => false, searchWikipediaTitles: nothing },
    };
    const load = makeLoader(mocks);
    const openai = load(src('api/openai.js'));
    const ai = load(src('services/aiService.js'));
    const boundary = load(src('services/sentenceBoundary.js'));
    // A model the picker does not list yet would fall back to the default.
    if (!ai.AI_MODELS.some(m => m.id === model)) {
        const [inPerM, outPerM] = PRICES[model] || [0, 0];
        ai.AI_MODELS.push({ id: model, label: model, tier: 'Test', inPerM, outPerM });
    }

    // Every request the passes make goes through here.
    const realFetch = fetchImpl || globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        if (effort) body.reasoning = { effort };
        const t0 = Date.now();
        const res = await realFetch(url, { ...init, body: JSON.stringify(body) });
        const text = await res.text();
        let data = null; try { data = JSON.parse(text); } catch (_) {}
        const u = data?.usage || {};
        let raw = null;
        for (const item of data?.output || []) for (const c of item?.content || []) if (c?.type === 'output_text') { try { raw = JSON.parse(c.text); } catch (_) { raw = c.text; } }
        calls.push({
            schema: body.text?.format?.name, effort: body.reasoning?.effort || null, maxOutputTokens: body.max_output_tokens,
            status: res.status, incomplete: data?.incomplete_details?.reason || null, ms: Date.now() - t0,
            usage: { input: u.input_tokens || 0, cached: u.input_tokens_details?.cached_tokens || 0, output: u.output_tokens || 0, reasoning: u.output_tokens_details?.reasoning_tokens || 0 },
            error: res.ok ? null : (data?.error?.message || `HTTP ${res.status}`),
            raw,
        });
        return new Response(text, { status: res.status, headers: { 'content-type': 'application/json' } });
    };
    const request = (req) => openai.requestJson({ apiKey, model, ...req });
    const result = { model, passes: {}, errors: {} };
    const t0 = Date.now();

    if (passes.includes('assistant')) {
        say(`  ${model}: summary, chapters and corrections…`);
        try {
            const r = await ai.analyzeEpisode(ep.id, { force: true });
            const chapterCalls = calls.filter(c => c.schema === 'episode_chapters');
            const rawChapters = chapterCalls.flatMap(c => c.raw?.chapters || []);
            const sentences = boundary.sentencesWithTimes(rows);
            // A start is "copied" when it reads exactly like a line's clock.
            const clocks = new Set(sentences.map(s => boundary.formatClock(s.startMs)));
            const onSentence = rawChapters.filter(c => clocks.has(String(c.start || '').trim().replace(/^\[|\]$/g, ''))).length;
            const finished = logs.find(l => l.msg === 'Episode assistant finished')?.data || {};
            result.passes.assistant = {
                chapters: r.chapters.map(c => ({ start: boundary.formatClock(c.startMs), title: c.title, blurb: c.blurb })),
                chaptersKept: r.chapters.length, chaptersProposed: rawChapters.length,
                startsOnASentence: onSentence, longTitles: rawChapters.filter(c => words(c.title) > 8).length,
                summary: r.summary, summarySentences: sentenceCount(r.summary), summaryWords: words(r.summary),
                fixes: r.fixes.map(f => ({ heard: f.heard, correct: f.correct, kind: f.kind, confidence: f.confidence, applied: !!f.applied, count: f.count })),
                fixesKept: r.fixes.length, fixesNotApplied: r.fixes.filter(f => !f.applied).length,
                fixesProposed: calls.filter(c => c.schema === 'transcript_corrections').reduce((n, c) => n + (c.raw?.corrections?.length || 0), 0),
                dropped: finished.dropped || [],
            };
        } catch (e) { result.errors.assistant = `${e.kind || 'error'}: ${e.message}`; }
    }

    if (passes.includes('punctuation')) {
        say(`  ${model}: punctuation…`);
        try {
            const rp = load(src('services/repunctuate.js'));
            const r = await rp.repunctuateEpisode(ep.id, { request, model });
            const byId = new Map(rows.map(x => [x.id, x.text]));
            result.passes.punctuation = {
                regions: r.regions, repaired: r.repaired, rejected: r.rejected, rowsChanged: captured.repunctuation.length,
                samples: captured.repunctuation.slice(0, 6).map(u => ({ before: byId.get(u.id), after: u.text })),
            };
        } catch (e) { result.errors.punctuation = `${e.kind || 'error'}: ${e.message}`; }
    }

    if (passes.includes('entities')) {
        say(`  ${model}: what the episode names…`);
        try {
            const en = load(src('services/entityIndex.js'));
            await en.indexEpisodeEntities(ep.id, { request, model });
            const kept = captured.entities || [];
            const byType = {};
            for (const e of kept) byType[e.type] = (byType[e.type] || 0) + 1;
            result.passes.entities = {
                proposed: calls.filter(c => c.schema === 'episode_entities').reduce((n, c) => n + (c.raw?.entities?.length || 0), 0),
                kept: kept.length, byType,
                list: kept.map(e => ({ type: e.type, surface: e.surface, canonical: e.canonical, hint: e.hint })),
            };
        } catch (e) { result.errors.entities = `${e.kind || 'error'}: ${e.message}`; }
    }

    if (passes.includes('translation')) {
        say(`  ${model}: translation with context…`);
        try {
            const sentences = boundary.sentencesWithTimes(rows).map(s => s.text);
            const spots = [0.25, 0.5, 0.75].map(f => Math.min(sentences.length - 1, Math.max(4, Math.floor(sentences.length * f))));
            const out = [];
            for (const i of spots) {
                const paragraphs = sentences.slice(i - 2, i + 1);
                const before = sentences.slice(i - 4, i - 2).join(' ');
                try {
                    const t = await ai.translateParagraphs({ paragraphs, lang, before });
                    out.push({ at: i, paragraphs, translations: t });
                } catch (e) { out.push({ at: i, paragraphs, error: `${e.kind || 'error'}: ${e.message}` }); }
            }
            result.passes.translation = { lang, samples: out, failed: out.filter(o => o.error).length };
        } catch (e) { result.errors.translation = `${e.kind || 'error'}: ${e.message}`; }
    }

    const usage = calls.reduce((u, c) => ({ input: u.input + c.usage.input, cached: u.cached + c.usage.cached, output: u.output + c.usage.output, reasoning: u.reasoning + c.usage.reasoning }), { input: 0, cached: 0, output: 0, reasoning: 0 });
    result.requests = calls.length;
    result.truncated = calls.filter(c => c.incomplete === 'max_output_tokens').length;
    result.failedRequests = calls.filter(c => c.error).map(c => `${c.schema}: ${c.error}`);
    result.usage = usage;
    result.cost = dollars(model, usage);
    result.seconds = Math.round((Date.now() - t0) / 10) / 100;
    // The raw answers are kept for the chapters (to re-check the starts); the
    // rest would only repeat what the passes already report.
    result.calls = calls.map(({ raw, ...c }) => (c.schema === 'episode_chapters' ? { ...c, raw } : c));
    return result;
};

const LANGS = { es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', ca: 'Catalan', nl: 'Dutch', pl: 'Polish', ru: 'Russian', ja: 'Japanese', zh: 'Chinese', ko: 'Korean', ar: 'Arabic', tr: 'Turkish', en: 'English' };

// ─── The report ──────────────────────────────────────────────────────────────

const table = (results) => {
    const row = (label, f) => [label.padEnd(34), ...results.map(r => String(f(r) ?? '—').padStart(16))].join('');
    const p = (r, k) => r.passes[k];
    const lines = [
        row('', r => r.model),
        row('Chapters kept / proposed', r => p(r, 'assistant') && `${p(r, 'assistant').chaptersKept} / ${p(r, 'assistant').chaptersProposed}`),
        row('Starts copied from a line', r => p(r, 'assistant') && `${p(r, 'assistant').startsOnASentence} / ${p(r, 'assistant').chaptersProposed}`),
        row('Titles over 8 words', r => p(r, 'assistant')?.longTitles),
        row('Summary sentences / words', r => p(r, 'assistant') && `${p(r, 'assistant').summarySentences} / ${p(r, 'assistant').summaryWords}`),
        row('Fixes kept / proposed', r => p(r, 'assistant') && `${p(r, 'assistant').fixesKept} / ${p(r, 'assistant').fixesProposed}`),
        row('  of which not applied (medium)', r => p(r, 'assistant')?.fixesNotApplied),
        row('  dropped (heard not in text)', r => p(r, 'assistant')?.dropped?.length),
        row('Punctuation regions / rejected', r => p(r, 'punctuation') && `${p(r, 'punctuation').regions} / ${p(r, 'punctuation').rejected}`),
        row('  rows changed', r => p(r, 'punctuation')?.rowsChanged),
        row('Entities kept / proposed', r => p(r, 'entities') && `${p(r, 'entities').kept} / ${p(r, 'entities').proposed}`),
        row('Translation samples failed', r => p(r, 'translation') && `${p(r, 'translation').failed} / ${p(r, 'translation').samples.length}`),
        row('Requests / truncated', r => `${r.requests} / ${r.truncated}`),
        row('Tokens in / out', r => `${r.usage.input} / ${r.usage.output}`),
        row('  of the output, reasoning', r => r.usage.reasoning),
        row('Wall clock (s)', r => r.seconds),
        row('Cost ($)', r => r.cost.toFixed(4)),
    ];
    return lines.join('\n');
};

const details = (results) => {
    const out = [];
    for (const r of results) {
        const a = r.passes.assistant;
        if (a) {
            out.push(`\n${r.model} — chapters:`);
            for (const c of a.chapters) out.push(`  ${c.start}  ${c.title}`);
            out.push(`${r.model} — summary:\n  ${a.summary}`);
            out.push(`${r.model} — corrections:`);
            for (const f of a.fixes) out.push(`  ${f.heard} → ${f.correct}  (${f.kind}, ${f.confidence}${f.applied ? '' : ', not applied'}) ×${f.count}`);
            if (a.dropped.length) out.push(`  dropped: ${a.dropped.join('; ')}`);
        }
        const e = r.passes.entities;
        if (e) {
            out.push(`${r.model} — names ${Object.entries(e.byType).map(([t, n]) => `${t}:${n}`).join(' ')}`);
            for (const x of e.list) out.push(`  [${x.type}] ${x.surface} → ${x.canonical} — ${x.hint}`);
        }
        for (const [k, v] of Object.entries(r.errors)) out.push(`${r.model} — ${k} FAILED: ${v}`);
        if (r.failedRequests.length) out.push(`${r.model} — failed requests: ${r.failedRequests.join('; ')}`);
    }
    const t = results.map(r => r.passes.translation).filter(Boolean);
    if (t.length) {
        out.push('\nTranslations, side by side:');
        t[0].samples.forEach((s, i) => {
            out.push(`  ${s.paragraphs.join(' | ')}`);
            results.forEach((r) => { const x = r.passes.translation?.samples[i]; out.push(`    ${r.model}: ${x?.error || (x?.translations || []).join(' | ')}`); });
        });
    }
    return out.join('\n');
};

// ─── Main ────────────────────────────────────────────────────────────────────

// The listener's key never goes in the repo: .env.local is gitignored.
const keyFromEnvLocal = () => {
    try {
        const m = /^OPENAI_API_KEY=(.+)$/m.exec(fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8'));
        return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
    } catch (_) { return null; }
};

const run = async (args, { fetchImpl, say = console.log } = {}) => {
    const db = openDb(args.db);
    if (args.list) {
        for (const e of episodesWithTranscripts(db)) say(`${e.id}\t${e.rows_n} rows\t${e.podcast_title || ''} — ${e.title || ''}`);
        return null;
    }
    const apiKey = args.key || process.env.OPENAI_API_KEY || keyFromEnvLocal();
    if (!apiKey) throw new Error('No key: set OPENAI_API_KEY, or put OPENAI_API_KEY=sk-… in .env.local (gitignored)');
    const ep = pickEpisode(db, args.episode);
    const models = String(args.models).split(',').map(s => s.trim()).filter(Boolean);
    const passes = String(args.passes).split(',').map(s => s.trim()).filter(Boolean);
    const chars = transcriptRows(db, ep.id).reduce((n, r) => n + String(r.text || '').length + 1, 0);
    const estTokens = Math.round(chars / 4);
    say(`Episode: ${ep.title} (${ep.podcast_title || ''}) — ${ep.rows_n} rows, about ${estTokens} tokens of transcript`);
    say(`Models: ${models.join(', ')}   Passes: ${passes.join(', ')}${args.effort ? `   Effort forced: ${args.effort}` : ''}`);
    say(`Rough cost: ${models.map(m => `${m} $${dollars(m, { input: estTokens * 3.2, cached: 0, output: 9000 }).toFixed(3)}`).join(', ')}`);
    const results = [];
    for (const model of models) results.push(await runModel({ model, ep, db, apiKey, passes, lang: args.lang, effort: args.effort, fetchImpl, say }));
    say(`\n${table(results)}`);
    say(details(results));
    const out = args.out || `model-compare-${String(ep.title || ep.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}.json`;
    fs.writeFileSync(out, JSON.stringify({ episode: { id: ep.id, title: ep.title, podcast: ep.podcast_title, rows: ep.rows_n }, lang: args.lang, effort: args.effort || null, results }, null, 2));
    say(`\nFull report: ${out}`);
    return results;
};

module.exports = { run, runModel, table, details, PRICES, dollars, makeLoader };

if (require.main === module) {
    run(parseArgs(process.argv.slice(2))).catch((e) => { console.error(e.message || e); process.exit(1); });
}
