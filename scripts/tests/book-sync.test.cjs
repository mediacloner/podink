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
    }, setTimeout, console });
    return exports;
}
const align = load('src/services/bookAlign.js');

test('speech anchors preserve EPUB text and ignore opening credits', () => {
    const words = ['PROLOGUE', 'Only', 'fools', 'climbed', 'to', 'the', 'surface.'];
    const heard = ['This', 'is', 'an', 'audiobook', 'Prologue', 'Only', 'fools', 'climbed', 'to', 'the', 'surface'];
    const asr = heard.map((text, i) => ({ text, start: 1000 + i * 700, end: 1400 + i * 700 }));
    const { rows, stats } = align.alignBookToAsr(words, asr, 10000);
    assert.deepEqual(Array.from(rows, r => r.text), words);
    assert.equal(rows[0].start, 3800);
    assert.equal(rows[1].start, 4500);
    assert.equal(stats.matchedRatio, 1);
});

test('missed book words interpolate between spoken anchors', () => {
    const words = ['Only', 'brave', 'fools', 'climbed.'];
    const asr = [{ text: 'only', start: 1000, end: 1300 }, { text: 'fools', start: 2200, end: 2500 }, { text: 'climbed', start: 2700, end: 3100 }];
    const { rows } = align.alignBookToAsr(words, asr, 4000);
    assert.equal(rows[1].start, 1300);
    assert.equal(rows[1].end, 2200);
    assert.deepEqual(Array.from(rows, r => r.text), words);
    assert.ok(rows.every((r, i) => r.end > r.start && (!i || r.start > rows[i - 1].start)));
});

function service(overrides = {}) {
    return load('src/services/bookService.js', {
        'react-native': { Platform: { OS: 'test' }, NativeModules: {} },
        'expo-file-system': {}, './zipReader': {}, './mdx': {}, './epubText': {}, './bookMap': {},
        './bookAlign': align, './bookSilence': {}, '../database/queries': {},
        './libraryEvents': { notifyLibraryChange() {} }, './logService': { log() {} }, ...overrides,
    });
}

test('legacy pause timing needs sync, verified speech timing does not', () => {
    const s = service();
    for (const state of [0, 1]) assert.equal(s.needsSync({ transcript_source: 'book', transcript_aligned: state, has_transcript: 1 }), true);
    for (const state of [2, s.TIMED_SPEECH]) assert.equal(s.needsSync({ transcript_source: 'book', transcript_aligned: state, has_transcript: 1 }), false);
    assert.equal(s.needsSync({ transcript_source: null, has_transcript: 1 }), false);
});

test('book sync uses speech alignment and reports completion', async () => {
    const events = [], calls = [];
    const ep = { id: 'chapter', local_audio_path: 'file:///book.mp4', duration: 60 };
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const s = service({
        '../database/queries': { getEpisodeById: async () => ep },
        './whisperService': { enqueueTranscription: async (...args) => { calls.push(args); args[2](50); } },
        './libraryEvents': { notifyLibraryChange: e => { events.push(e); if (e.type === 'book-sync-done') finish(); } },
    });
    assert.equal(s.queueVoiceSync([ep, ep]), 1);
    await done;
    assert.equal(calls.length, 1);
    assert.equal(calls[0][5].align, true);
    assert.equal(events[0].percent, 50);
    assert.equal(s.getSyncingId(), null);
});

test('failed alignment reports the failure and releases the queue', async () => {
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const ep = { id: 'chapter', local_audio_path: 'file:///book.mp4' };
    const s = service({
        '../database/queries': { getEpisodeById: async () => ep },
        './whisperService': { enqueueTranscription: async () => { throw new Error('Audio does not match'); } },
        './libraryEvents': { notifyLibraryChange: e => finish(e) },
    });
    s.queueVoiceSync([ep], { ask: true });
    const event = await done;
    assert.equal(event.type, 'book-sync-error');
    assert.equal(event.ask, true);
    assert.equal(s.getSyncingId(), null);
});

test('multiword speech segments share their interval instead of collapsing', () => {
    const { rows, stats } = align.alignBookToAsr(['Only', 'fools', 'climbed.'], [{ text: 'Only fools climbed', start: 1000, end: 2500 }], 3000);
    assert.equal(stats.matchedRatio, 1);
    assert.deepEqual(Array.from(rows, r => r.start), [1000, 1500, 2000]);
    assert.deepEqual(Array.from(rows, r => r.end), [1500, 2000, 2500]);
});

test('alignment failure preserves the existing transcript', async () => {
    let writes = 0;
    const s = service({
        'expo-file-system': {
            Directory: class {}, Paths: { document: '/books' },
            File: class { exists = true; async text() { return '{}'; } },
        },
        './bookMap': { wordsInRange: () => [{ text: 'skyward' }, { text: 'starfighter' }] },
        '../database/queries': {
            getEpisodeById: async () => ({ id: 'chapter', podcast_feed_url: 'local://book', book_range: { s0: 0, s1: 1 }, duration: 60 }),
            replaceEpisodeTranscript: async () => { writes++; },
        },
    });
    await assert.rejects(s.alignEpisodeWithAsr('chapter', [{ text: 'unrelated', start: 0, end: 100 }]), /does not read this text/);
    assert.equal(writes, 0);
});

test('database preserves speech-aligned state instead of clamping it to misfit', async () => {
    const writes = [];
    const db = { withTransactionAsync: task => task(), runAsync: async (sql, args) => writes.push({ sql, args }) };
    const queries = load('src/database/queries.js', { './db': { openDatabaseContext: async () => db } });
    await queries.replaceEpisodeTranscript('chapter', [{ start: 1000, end: 1500, text: 'Only' }], { source: 'book', aligned: 3 });
    assert.equal(writes.find(w => w.sql.startsWith('UPDATE Episodes')).args[2], 3);
});
