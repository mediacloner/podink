/**
 * OpenAI Responses API — the one call the episode assistant makes
 * (services/aiService.js): a model, an instruction, the transcript, and a
 * JSON schema the answer must fit. Nothing else of OpenAI's is used.
 *
 * The key is the listener's own (Settings → Episode assistant); the app has
 * none built in. `store: false` asks OpenAI not to keep the request.
 *
 * Errors carry `kind` so the sheet can say something useful:
 *   'auth'      the key was refused (401)
 *   'quota'     rate limit or no credit left (429)
 *   'model'     the model name is unknown to the account (404 / 400 model)
 *   'offline'   no network
 *   'truncated' the answer hit max_output_tokens
 *   'refusal'   the model declined
 *   'malformed' the answer was not the JSON the schema asked for
 *   'server'    anything else, with OpenAI's message
 */
import { log } from '../services/logService';

const ENDPOINT = 'https://api.openai.com/v1/responses';
const TIMEOUT_MS = 240000;   // a 30k-token transcript takes a while at the budget tier

const tagged = (kind, message, extra = {}) => Object.assign(new Error(message), { kind, ...extra });

const post = async (apiKey, body, signal) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const onOuter = () => ctrl.abort();
    if (signal) {
        if (signal.aborted) ctrl.abort();
        else signal.addEventListener('abort', onOuter);
    }
    let res;
    try {
        res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
    } catch (e) {
        if (e?.name === 'AbortError' && !signal?.aborted) throw tagged('offline', 'OpenAI did not answer in time');
        if (e?.name === 'AbortError') throw e;
        throw tagged('offline', e?.message || 'Network request failed');
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onOuter);
    }
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (res.ok) return data;
    const err = data?.error || {};
    const msg = err.message || `HTTP ${res.status}`;
    if (res.status === 401) throw tagged('auth', 'OpenAI refused the API key. Check it in Settings → Episode assistant.', { status: 401 });
    if (res.status === 429) {
        const quota = /quota|billing|credit/i.test(`${err.code || ''} ${err.type || ''} ${msg}`);
        throw tagged('quota', quota ? 'Your OpenAI account has no credit left.' : 'OpenAI is rate-limiting this key — try again in a minute.', { status: 429 });
    }
    if (res.status === 404 || (res.status === 400 && /model/i.test(msg) && /not (found|exist|available)|does not exist|unknown/i.test(msg))) {
        throw tagged('model', `OpenAI does not know the model "${body.model}" for this account.`, { status: res.status });
    }
    throw tagged('server', `OpenAI: ${msg}`, { status: res.status, code: err.code, param: err.param, raw: msg });
};

// The text the model wrote, out of the Responses output list.
const extractText = (data) => {
    for (const item of Array.isArray(data?.output) ? data.output : []) {
        if (item?.type !== 'message') continue;
        for (const c of item.content || []) {
            if (c?.type === 'output_text' && typeof c.text === 'string') return c.text;
            if (c?.type === 'refusal') throw tagged('refusal', c.refusal || 'The model declined to answer.');
        }
    }
    if (typeof data?.output_text === 'string') return data.output_text;
    return null;
};

/**
 * One structured request. Resolves { json, usage: { input, output, cached },
 * model }. `schema` is a strict JSON schema (every object lists all its
 * properties in `required` and has additionalProperties false).
 * `effort` is the reasoning effort ('minimal' | 'low' | 'medium' | 'high');
 * a model that rejects the parameter is asked again without it.
 */
export const requestJson = async ({
    apiKey, model, instructions, input, schemaName, schema, maxOutputTokens = 6000, effort = 'low', signal,
}) => {
    if (!apiKey) throw tagged('auth', 'No OpenAI API key. Add yours in Settings → Episode assistant.');
    const body = {
        model,
        instructions,
        input,
        store: false,
        max_output_tokens: maxOutputTokens,
        text: { format: { type: 'json_schema', name: schemaName, schema, strict: true } },
    };
    if (effort) body.reasoning = { effort };
    let data;
    try {
        data = await post(apiKey, body, signal);
    } catch (e) {
        // Not every model takes a reasoning effort; try once without.
        if (e?.kind === 'server' && e.status === 400 && body.reasoning && /reasoning|effort/i.test(e.raw || '')) {
            log('SERVICE', 'OpenAI rejected the reasoning parameter — retrying without', { model, error: e.raw });
            delete body.reasoning;
            data = await post(apiKey, body, signal);
        } else {
            throw e;
        }
    }
    if (data?.status === 'incomplete') {
        const why = data?.incomplete_details?.reason || 'unknown';
        if (why === 'max_output_tokens') throw tagged('truncated', 'The answer was cut short — the episode may be too long for one request.');
        throw tagged('server', `OpenAI stopped early (${why}).`);
    }
    const text = extractText(data);
    if (text == null) throw tagged('malformed', 'OpenAI returned no text.');
    let json;
    try { json = JSON.parse(text); } catch (_) { throw tagged('malformed', 'OpenAI returned something that is not the expected JSON.'); }
    const u = data?.usage || {};
    return {
        json,
        model: data?.model || model,
        usage: {
            input: u.input_tokens || 0,
            output: u.output_tokens || 0,
            cached: u.input_tokens_details?.cached_tokens || 0,
        },
    };
};
