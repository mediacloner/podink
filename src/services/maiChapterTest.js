/**
 * The comparison: one reading, two transcripts.
 *
 * The phone's transcript and the MAI one go through the same pass
 * (aiService.chaptersAndSummary) — same model, same endpoint, same episode
 * notes, same names pass, same part splitting — so a difference between the
 * two answers is a difference between the transcripts and not between the
 * ways they were read. Nothing is written to the database: the episode keeps
 * the summary, chapters and fixes the assistant wrote for it.
 *
 * Both sides run on OpenRouter, on the key in Settings → Cloud transcription
 * test. The assistant's own pass talks to OpenAI's Responses API with its own
 * key; a comparison that changed provider at the same time as the transcript
 * would say nothing about either.
 *
 * What is deliberately left out of both sides: EpisodeFixes. The assistant
 * wrote them against the phone's text, so only one side could use them.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getEpisodeById, getMaiTranscript, getTranscriptsForEpisode } from '../database/queries';
import { chaptersAndSummary, episodeNotes } from './aiService';
import { applyNameCorrections, findNameCorrections, nameCandidates } from './nameText';
import { showNotesPlainText } from './showNotes';
import { OPENROUTER_KEY } from './maiTranscriptionService';

// Prices per million tokens (OpenRouter, 2026-09-22) — for the line under
// each answer, not for billing.
export const CHAPTER_TEST_MODELS = [
    { id: 'openai/gpt-5.6-luna', label: 'Luna', input: 0.20, output: 1.20 },
    { id: 'google/gemini-3-flash-preview', label: 'Gemini 3 Flash', input: 0.50, output: 3.00 },
];

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS = 180000;
// OpenRouter counts a reasoning model's thinking against max_tokens, which
// the Responses API does not — the ceiling is lifted by the same amount on
// both sides so neither answer is the one that ran out of room.
const THINKING_HEADROOM = 3000;

/** One structured call, in the shape aiService expects of api/openai.js. */
const openRouterRequest = (key, modelId) => async ({ instructions, schemaName, schema, input, maxOutputTokens }) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let response;
    try {
        response = await fetch(ENDPOINT, {
            method: 'POST',
            signal: ctrl.signal,
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: modelId,
                messages: [{ role: 'system', content: instructions }, { role: 'user', content: input }],
                response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
                max_tokens: maxOutputTokens + THINKING_HEADROOM,
                reasoning: { effort: 'low' },          // api/openai.js asks for the same
                provider: { require_parameters: true },
            }),
        });
    } catch (error) {
        throw new Error(ctrl.signal.aborted ? 'The provider took too long' : (error?.message || 'Could not reach OpenRouter'));
    } finally {
        clearTimeout(timer);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);
    const choice = data?.choices?.[0];
    if (choice?.finish_reason === 'length') throw new Error('The answer was cut short');
    const content = choice?.message?.content;
    let json = null;
    try { json = typeof content === 'string' ? JSON.parse(content) : content; } catch (_) { json = null; }
    if (!json) throw new Error('The answer was not the JSON the schema asked for');
    const u = data?.usage || {};
    return {
        json,
        usage: {
            input: u.prompt_tokens || 0,
            output: u.completion_tokens || 0,
            cached: u.prompt_tokens_details?.cached_tokens || 0,
        },
    };
};

/** The names pass on whichever transcript. The candidates come from the
 *  episode's own title, author and notes, so both transcripts are scanned
 *  against the same list — each with the spellings it actually got wrong. */
const withNames = (rows, candidates) => (
    rows.length && candidates.length ? applyNameCorrections(rows, findNameCorrections(rows, candidates)) : rows
);

const dollars = (model, usage) => (usage.input * model.input + usage.output * model.output) / 1e6;

/**
 * Runs every model in CHAPTER_TEST_MODELS over both transcripts, calling
 * `onResult` as each answer lands (a model at a time, the phone's transcript
 * first). A result is { model, source: 'local' | 'mai', sourceLabel, summary,
 * chapters, cost } or { model, source, sourceLabel, error }. Resolves to all
 * of them; rejects only when there is nothing to compare.
 */
export const testMaiChapters = async (episode, onResult = () => {}) => {
    const key = ((await AsyncStorage.getItem(OPENROUTER_KEY)) || '').trim();
    if (!key) throw new Error('Add your OpenRouter key in Settings first.');
    const ep = (await getEpisodeById(episode.id)) || episode;
    const [mai, localRows] = await Promise.all([getMaiTranscript(ep.id), getTranscriptsForEpisode(ep.id)]);
    if (!mai.segments.length) throw new Error('Run the MAI transcription test first.');
    const notes = episodeNotes(ep);
    const candidates = nameCandidates({
        title: ep.title || '', author: ep.podcast_author || '', notes: showNotesPlainText(ep.description || ''),
    });
    const sources = [
        localRows.length ? { key: 'local', label: 'Phone transcript', rows: withNames(localRows, candidates) } : null,
        { key: 'mai', label: 'MAI transcript', rows: withNames(mai.segments, candidates) },
    ].filter(Boolean);

    const results = [];
    for (const model of CHAPTER_TEST_MODELS) {
        for (const source of sources) {
            const head = { model, source: source.key, sourceLabel: source.label };
            let result;
            try {
                const pass = await chaptersAndSummary({
                    ep, rows: source.rows, notes, request: openRouterRequest(key, model.id),
                });
                result = { ...head, summary: pass.summary, chapters: pass.chapters, cost: dollars(model, pass.usage) };
            } catch (error) {
                result = { ...head, error: error?.message || 'Provider returned an error' };
            }
            results.push(result);
            onResult(result);
        }
    }
    return results;
};
