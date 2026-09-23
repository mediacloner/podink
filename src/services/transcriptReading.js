/**
 * One way of handing a transcript to the model, shared by every pass that
 * reads a whole episode (5.6.0): the chapters and summary, the corrections
 * (services/aiService.js) and what the episode names (services/entityIndex.js).
 *
 * Each of those passes sends the same hour of text, and until now each paid
 * for all of it — three passes, three times the transcript, nothing cached
 * (an hour about Constantine: 62k input tokens, 0 cached). OpenAI caches a
 * request's prefix and bills a repeat of it at a tenth, but only a prefix
 * that is the same to the token: the instructions, the output schema (which
 * OpenAI places ahead of the instructions) and the start of the input. So
 * every pass here asks with the same instructions and the same schema, the
 * episode and its transcript come first, and what this pass is for comes
 * last, in a message of its own. The schema has room for every pass's answer;
 * a pass fills its own fields and leaves the rest empty, which costs a handful
 * of output tokens against the transcript's thousands.
 *
 * The cache is written when the first request has read the text, so the
 * chapters pass goes first and the others follow it (aiService.analyzeEpisode).
 * It lasts minutes, not days: a pass asked for later in the Player reads the
 * text at full price, as before.
 */
import { PHRASE_SCHEMA } from './phraseIndex';

export const ENTITY_TYPES = ['person', 'place', 'book', 'film', 'tv', 'podcast', 'album'];

export const READING_INSTRUCTIONS = `You read automatic transcripts of podcast episodes for an app that helps people listen and learn English. The transcript was made on a phone: one sentence per line, each led by the time it starts, as [mm:ss] or [h:mm:ss]. The recogniser misspells names; the episode notes, when given, spell them right — use the notes for spelling and to recognise the segments the show announces, never as a source of what was said.

The first message gives the episode and its transcript. The last message says what to do with it. The answer has a field for every kind of task; fill only the fields the task names and leave every other one empty — an empty string or an empty list.`;

const CHAPTERS = {
    type: 'array',
    items: {
        type: 'object',
        additionalProperties: false,
        required: ['start', 'title', 'blurb'],
        properties: {
            start: { type: 'string', description: 'Time copied from the transcript line where the chapter begins, mm:ss or h:mm:ss' },
            title: { type: 'string' },
            blurb: { type: 'string' },
        },
    },
};

const CORRECTIONS = {
    type: 'array',
    items: {
        type: 'object',
        additionalProperties: false,
        required: ['heard', 'correct', 'kind', 'context', 'confidence'],
        properties: {
            heard: { type: 'string' },
            correct: { type: 'string' },
            kind: { type: 'string', enum: ['name', 'title', 'place', 'word'] },
            context: { type: 'string' },
            confidence: { type: 'string', enum: ['high', 'medium'] },
        },
    },
};

const ENTITIES = {
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
};

export const READING_SCHEMA_NAME = 'episode_reading';
export const READING_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'chapters', 'corrections', 'entities', 'phrases'],
    properties: {
        summary: { type: 'string' },
        chapters: CHAPTERS,
        corrections: CORRECTIONS,
        entities: ENTITIES,
        phrases: PHRASE_SCHEMA,
    },
};

/** The routing hint that sends one episode's passes to the same cache. */
export const readingCacheKey = (episodeId) => `podink-episode-${episodeId}`;

/**
 * The fields of one request, for `request` (api/openai.requestJson's shape):
 * the shared instructions and schema, the episode first, the task last.
 * `text` is the episode's head, its part label and its transcript lines —
 * the same string for every pass over the same part, or the cache misses.
 */
export const readingRequest = ({ text, task, episodeId, maxOutputTokens }) => ({
    instructions: READING_INSTRUCTIONS,
    schemaName: READING_SCHEMA_NAME,
    schema: READING_SCHEMA,
    input: [
        { role: 'user', content: text },
        { role: 'developer', content: task },
    ],
    cacheKey: episodeId != null ? readingCacheKey(episodeId) : undefined,
    maxOutputTokens,
});
