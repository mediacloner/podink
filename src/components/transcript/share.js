import { Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { langEnglishName } from './translate';
import { formatClock, sentencesWithTimes } from '../../services/sentenceBoundary';

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

// A passage or a word is asked about with the lines on both sides:
// who "she" is, what "it" turns out to be, which of a word's senses the
// talk is about — the before and the after settle what the sentence alone
// leaves open.
const afterBlock = (after) => {
    const ctx = (after || '').trim();
    return ctx ? `\n\nWhat is said just after, for context only:\n"${ctx}"` : '';
};

// Whole request in one share, so the assistant answers directly instead of
// asking what to do with a pasted paragraph. `before` / `after` are the
// transcript text around the passage, `source` the episode / programme title.
// The questions are built apart from the share so the cards can ask them of
// Luna / Sol in the app (AssistantAnswer) and share the very same text.
export const questionAboutText = (text, lang, { before = '', after = '', source = '' } = {}) => {
    const target = langEnglishName(lang);
    const ask = target === 'English'
        ? 'Explain this passage in simpler English and point out any tricky words or expressions:'
        : `Translate this passage to ${target} and briefly explain any tricky words or expressions:`;
    return `${sourceLine(source)}${contextBlock(before)}\n\n${ask}\n\n"${text}"${afterBlock(after)}`;
};

export const questionAboutWord = (word, sentence, lang, { before = '', after = '', source = '' } = {}) => {
    const target = langEnglishName(lang);
    const inLang = target === 'English' ? '' : `, and how would you say it in ${target}`;
    const hasSentence = !!sentence && sentence.trim().toLowerCase() !== word.trim().toLowerCase();
    const where = hasSentence ? `\n\nThe sentence:\n"${sentence.trim()}"\n\nWhat does the English word "${word}" mean in this sentence${inLang}? Use the lines before and after to say what it refers to here and which of its senses is meant.`
        : `\n\nWhat does the English word "${word}" mean${inLang}?`;
    return `${sourceLine(source)}${contextBlock(before)}${where}${afterBlock(after)}\n\nInclude a short example sentence.`;
};

export const shareQuestion = (question) => shareText(question, 'Ask an assistant');

// ─── Whole-transcript export ─────────────────────────────────────────────────
// One line per sentence, led by the time it starts, so the text can be read
// elsewhere, searched, kept, or laid next to another transcript of the same
// episode to see where the recognizer went wrong. Rows are usually one word
// each (token timestamps); a sentence-level row from the window fallback
// gives all its words the row's start. The sentences and the clock format
// are sentenceBoundary's, shared with the episode assistant.
export const buildTranscriptExport = (episode, segments) => {
    const lines = sentencesWithTimes(segments).map((s) => `[${formatClock(s.startMs)}] ${s.text}`);
    const head = [episode?.podcast_title, episode?.title].filter(Boolean).join(' — ');
    return (head ? [head, '', ...lines] : lines).join('\n');
};
