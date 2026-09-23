// Every pass over an episode's transcript opens with the same prefix —
// instructions, schema, the episode's text — so OpenAI can cache it
// (services/transcriptReading.js). Run: node --test scripts/tests/
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const babel = require('@babel/core');

function load(file, mocks = {}) {
    const exports = {};
    const code = babel.transformSync(fs.readFileSync(file, 'utf8'), {
        configFile: false, babelrc: false,
        plugins: ['@babel/plugin-transform-modules-commonjs'],
    }).code;
    vm.runInNewContext(code, { exports, require: (id) => {
        if (id in mocks) return mocks[id];
        throw new Error(`Unexpected dependency ${id}`);
    }, setTimeout, console, Promise });
    return exports;
}

const reading = load('src/services/transcriptReading.js', {
    './phraseIndex': { PHRASE_SCHEMA: { type: 'array', items: { type: 'string' } } },
});

const rows = [
    { start: 0, end: 4000, text: 'Welcome to the show about Constantine.' },
    { start: 4000, end: 9000, text: 'He was born in Naissus.' },
];
const calls = [];
let inFlight = 0, overlapped = false;
const requestJson = async (req) => {
    calls.push(req);
    inFlight += 1;
    if (inFlight > 1) overlapped = true;
    await new Promise(r => setTimeout(r, 5));
    inFlight -= 1;
    const cached = calls.length > 1 ? 900 : 0;
    const json = { summary: 's', chapters: [{ start: '00:00', title: 'Start', blurb: 'b' }], corrections: [], entities: [], phrases: [] };
    return { json, usage: { input: 1000, output: 10, cached } };
};

const noop = () => {};
const ai = load('src/services/aiService.js', {
    '@react-native-async-storage/async-storage': { __esModule: true, default: { getItem: async (k) => (k === '@openai_api_key' ? 'sk-test' : null) } },
    '../api/openai': { requestJson },
    '../database/queries': {
        getEpisodeById: async (id) => ({ id, title: 'Constantine', podcast_title: "You're Dead to Me", duration: 9 }),
        isRadioFeedUrl: () => false, recordApiSpend: async () => {}, replaceEpisodeAnalysis: async () => {},
    },
    './nameIndex': { getNameCorrectedTranscript: async () => rows, indexEpisodeNames: async () => null },
    './bookIndex': { indexEpisodeBooks: async () => null },
    './nameText': { countPhrase: () => ({ count: 0 }), fold: s => String(s).toLowerCase(), normalizePhrase: s => String(s || '').trim() },
    './showNotes': { showNotesPlainText: s => s },
    './sentenceBoundary': {
        formatClock: ms => `00:${String(Math.floor(ms / 1000)).padStart(2, '0')}`,
        sentencesWithTimes: rs => rs.map(r => ({ startMs: r.start, endMs: r.end, text: r.text })),
    },
    '../components/transcript/translate': { langEnglishName: s => s },
    './transcriptReading': reading,
    './libraryEvents': { notifyLibraryChange: noop },
    './logService': { log: noop },
});

test('chapters, fixes and the pass alongside share one cacheable prefix', async () => {
    const alongside = async (prepared, request) => {
        const r = await request(reading.readingRequest({ text: prepared.texts[0], task: 'Task: tag.', episodeId: prepared.episodeId }));
        return { raw: r.json.entities, rawPhrases: r.json.phrases, usage: r.usage, parts: 1 };
    };
    const done = await ai.analyzeEpisode(7, { force: true, scanBooks: false, alongside });
    assert.equal(calls.length, 3);
    const prefix = c => JSON.stringify([c.instructions, c.schemaName, c.schema, c.input[0], c.cacheKey]);
    assert.equal(new Set(calls.map(prefix)).size, 1);
    assert.equal(calls[0].cacheKey, 'podink-episode-7');
    assert.match(calls[0].input[0].content, /Transcript:\n\[00:00\] Welcome/);
    assert.match(calls[0].input[1].content, /^Task: write the table of contents/);
    assert.match(calls[1].input[1].content, /^Task: proofread/);
    assert.equal(calls[0].input[1].role, 'developer');
    assert.ok(overlapped, 'fixes and the pass alongside run side by side');
    assert.equal(done.alongside.parts, 1);
    assert.equal(done.usage.cached, 900);   // the fixes; the alongside pass keeps its own usage
});
