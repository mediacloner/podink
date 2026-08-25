import { Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { langEnglishName } from './translate';

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

// Whole request in one share, so the assistant answers directly instead of
// asking what to do with a pasted paragraph.
export const askAssistantAboutText = (text, lang) => {
    const target = langEnglishName(lang);
    const ask = target === 'English'
        ? 'Explain this English text in simpler English and point out any tricky words or expressions:'
        : `Translate this English text to ${target} and briefly explain any tricky words or expressions:`;
    return shareText(`${ask}\n\n"${text}"`, 'Ask an assistant');
};

export const askAssistantAboutWord = (word, sentence, lang) => {
    const target = langEnglishName(lang);
    const inLang = target === 'English' ? '' : `, and how would you say it in ${target}`;
    const hasSentence = !!sentence && sentence.trim().toLowerCase() !== word.trim().toLowerCase();
    const ctx = hasSentence ? `\n\nIt appears in this sentence:\n"${sentence.trim()}"` : '';
    return shareText(
        `What does the English word "${word}" mean${inLang}? Include a short example sentence.${ctx}`,
        'Ask an assistant',
    );
};
