import { Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { langEnglishName } from './translate';
import { splitSentences } from '../../services/sentenceBoundary';

// Hands text to the system share sheet. From there it can go to ChatGPT,
// Gemini, Claude, a notes app, a chat — whatever is installed — without this
// app carrying a per-assistant integration that breaks on their next update.
// The sheet itself needs no network, so it's the escape hatch when the
// translation service is down or throttled.
export const shareText = async (message, dialogTitle = 'Share') => {
    try {
        await Share.share({ message }, { dialogTitle });
    } catch (_) {}
};

// Resolves true when the copy succeeded, so the caller can flash feedback.
export const copyText = async (text) => {
    try {
        await Clipboard.setStringAsync(text);
        return true;
    } catch (_) {
        return false;
    }
};

// Every request opens with where the text comes from and, when the caller
// has them, the lines spoken just before it: an assistant reading one
// paragraph cold guesses at the pronouns, the joke, the half-sentence that
// the previous lines make obvious. The context is labelled as such so the
// answer is about the passage, not about the context.
const sourceLine = (source) => {
    const s = (source || '').trim();
    return s ? `From an English podcast / radio transcript ("${s}").` : 'From an English podcast / radio transcript.';
};
const contextBlock = (before) => {
    const ctx = (before || '').trim();
    return ctx ? `\n\nWhat was said just before, for context only (no need to explain it):\n"${ctx}"` : '';
};

// Whole request in one share, so the assistant answers directly instead of
// asking what to do with a pasted paragraph. `before` is the transcript
// text preceding the passage, `source` the episode / programme title.
export const askAssistantAboutText = (text, lang, { before = '', source = '' } = {}) => {
    const target = langEnglishName(lang);
    const ask = target === 'English'
        ? 'Explain this passage in simpler English and point out any tricky words or expressions:'
        : `Translate this passage to ${target} and briefly explain any tricky words or expressions:`;
    return shareText(`${sourceLine(source)}${contextBlock(before)}\n\n${ask}\n\n"${text}"`, 'Ask an assistant');
};

export const askAssistantAboutWord = (word, sentence, lang, { before = '', source = '' } = {}) => {
    const target = langEnglishName(lang);
    const inLang = target === 'English' ? '' : `, and how would you say it in ${target}`;
    const hasSentence = !!sentence && sentence.trim().toLowerCase() !== word.trim().toLowerCase();
    const where = hasSentence ? `\n\nThe sentence:\n"${sentence.trim()}"\n\nWhat does the English word "${word}" mean in this sentence${inLang}?`
        : `\n\nWhat does the English word "${word}" mean${inLang}?`;
    return shareText(
        `${sourceLine(source)}${contextBlock(hasSentence ? before : '')}${where} Include a short example sentence.`,
        'Ask an assistant',
    );
};

// ─── Whole-transcript export ─────────────────────────────────────────────────
// One line per sentence, led by the time it starts, so the text can be read
// elsewhere, searched, kept, or laid next to another transcript of the same
// episode to see where the recognizer went wrong. Rows are usually one word
// each (token timestamps); a sentence-level row from the window fallback
// gives all its words the row's start.
const fmtTime = (ms) => {
    const total = Math.max(0, Math.floor((ms || 0) / 1000));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

export const buildTranscriptExport = (episode, segments) => {
    const words = [];
    for (const seg of segments) {
        const startMs = seg.start_time ?? seg.start ?? 0;
        for (const t of (seg.text || '').trim().split(/\s+/)) {
            if (t) words.push({ text: t, startMs });
        }
    }
    const lines = splitSentences(words).map(
        (ws) => `[${fmtTime(ws[0].startMs)}] ${ws.map((w) => w.text).join(' ')}`
    );
    const head = [episode?.podcast_title, episode?.title].filter(Boolean).join(' — ');
    return (head ? [head, '', ...lines] : lines).join('\n');
};
