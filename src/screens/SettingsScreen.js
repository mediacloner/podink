import React, { useState, useEffect } from 'react';
import {
    View, Text, TouchableOpacity, TextInput,
    StyleSheet, ScrollView, Switch, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Feather as Icon } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SHERPA_MODELS, ensureSherpaModel, isSherpaModelDownloaded, deleteSherpaModel } from '../services/downloadService';
import { resetService } from '../services/whisperService';
import { ASK_DELETE_ON_FINISH_KEY } from '../services/playbackService';
import { AUTO_DELETE_FINISHED_KEY } from '../services/episodeService';
import {
    DICTIONARY_SOURCE, deleteDictionary, getCachedRemoteDictionaries, getGithubToken, getStoredGithubToken,
    getInstalledDictionaries, hasBuiltInToken, installDictionary, isInstalling, listRemoteDictionaries, setGithubToken,
} from '../services/dictionaryService';
import { onLibraryChange } from '../services/libraryEvents';
import { showAlert } from '../components/AppAlert';
import { useTheme, useStyles, withAlpha, type, THEMES, THEME_OPTIONS } from '../theme';

// Learning-focused copy overrides for the model picker.
const MODEL_COPY = {
    parakeet_110m_en: 'Default · fast · punctuation · word-by-word highlighting · NVIDIA Parakeet 110M (CC BY 4.0)',
    parakeet_tdt_0_6b_v2_en: 'High accuracy · ~5× slower · 460 MB download, ~630 MB installed · NVIDIA Parakeet TDT 0.6B v2 (CC BY 4.0)',
};

const DEFAULT_MODEL_KEY = SHERPA_MODELS.parakeet_110m_en ? 'parakeet_110m_en' : Object.keys(SHERPA_MODELS)[0];

const MODELS = Object.entries(SHERPA_MODELS).map(([id, m]) => ({
    id,
    name: m.label,
    size: `~${m.downloadSizeMB || m.totalSizeMB} MB`,
    desc: MODEL_COPY[id] || m.desc,
    recommended: !!m.recommended || id === DEFAULT_MODEL_KEY,
}));

const LANGUAGES = [
    { code: 'es', label: 'Spanish' },
    { code: 'fr', label: 'French' },
    { code: 'de', label: 'German' },
    { code: 'it', label: 'Italian' },
    { code: 'pt', label: 'Portuguese' },
    { code: 'ja', label: 'Japanese' },
    { code: 'zh', label: 'Chinese' },
    { code: 'ko', label: 'Korean' },
    { code: 'ru', label: 'Russian' },
    { code: 'en', label: 'English' },
];

// Must match the cycle list in PlayerControls (RATES there is [0.7, 0.85, 1,
// 1.15, 1.3, 1.5]) so a default picked here is always reachable in the player.
const RATES = ['0.7', '0.85', '1', '1.15', '1.3', '1.5'];

const FONT_SIZE_MIN = 18;
const FONT_SIZE_MAX = 30;

const formatMB = (bytes) => (bytes > 0 ? `${(bytes / 1e6).toFixed(bytes >= 10e6 ? 0 : 1)} MB` : '');
// "ghp_abcdefgh…wxyz" — enough to recognise a token, never the whole thing.
const maskToken = (t) => (t.length <= 10 ? '••••' : `${t.slice(0, 7)}…${t.slice(-4)}`);

const SettingsScreen = () => {
    const { colors, themeName, setTheme } = useTheme();
    const styles = useStyles(makeStyles);
    const { bottom } = useSafeAreaInsets();
    const navigation = useNavigation();
    const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL_KEY);
    const [isModelDownloaded, setIsModelDownloaded] = useState(false);
    const [isDownloading, setIsDownloading] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState(0);

    // Learning preferences (shared AsyncStorage contract with the player)
    const [translationLang, setTranslationLang] = useState('es');
    const [fontSize, setFontSize] = useState(22);
    const [playbackRate, setPlaybackRate] = useState('1');
    // Stored as '1'/'0'; absent means on (TranscriptHighlighter reads the same key).
    const [pauseOnLookup, setPauseOnLookup] = useState(true);
    // Same shape; FinishedEpisodePrompt reads it when a downloaded episode ends.
    const [askDeleteOnFinish, setAskDeleteOnFinish] = useState(true);
    // Same shape; episodeService's sweep reads it on launch / resume.
    const [autoDeleteFinished, setAutoDeleteFinished] = useState(true);

    // Offline dictionaries (private GitHub repository, see dictionaryService)
    const [ghToken, setGhToken] = useState('');
    const [tokenDraft, setTokenDraft] = useState('');
    const [tokenEditing, setTokenEditing] = useState(false);
    const [remoteDicts, setRemoteDicts] = useState([]);
    const [installedDicts, setInstalledDicts] = useState([]);
    const [dictBusy, setDictBusy] = useState({});          // id → { phase, percent }
    const [dictListLoading, setDictListLoading] = useState(false);

    useEffect(() => { loadPreference(); loadLearningPrefs(); }, []);
    useEffect(() => { checkModelStatus(selectedModel); }, [selectedModel]);

    // A stack screen since 2.3.0 (opened from the header gear), so it styles
    // its own header like Vocabulary / Debug Log do.
    useEffect(() => {
        navigation.setOptions({
            headerStyle: { backgroundColor: colors.bg },
            headerTintColor: colors.textPrimary,
            headerTitleStyle: { ...type.heading },
            headerShadowVisible: false,
            title: 'Settings',
        });
    }, [navigation, colors]);

    const loadPreference = async () => {
        try {
            const saved = await AsyncStorage.getItem('@whisper_model');
            // Stale keys (removed models) fall back to the default; the
            // transcription service persists the corrected value itself.
            setSelectedModel(saved && SHERPA_MODELS[saved] ? saved : DEFAULT_MODEL_KEY);
        } catch (e) {}
    };

    const loadLearningPrefs = async () => {
        try {
            const [lang, size, rate, pause, askDelete, autoDelete] = await Promise.all([
                AsyncStorage.getItem('@translation_lang'),
                AsyncStorage.getItem('@transcript_font_size'),
                AsyncStorage.getItem('@playback_rate'),
                AsyncStorage.getItem('@pause_on_lookup'),
                AsyncStorage.getItem(ASK_DELETE_ON_FINISH_KEY),
                AsyncStorage.getItem(AUTO_DELETE_FINISHED_KEY),
            ]);
            if (lang) setTranslationLang(lang);
            setPauseOnLookup(pause !== '0');
            setAskDeleteOnFinish(askDelete !== '0');
            setAutoDeleteFinished(autoDelete !== '0');
            if (size) {
                const parsed = parseInt(size, 10);
                if (!Number.isNaN(parsed)) {
                    setFontSize(Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, parsed)));
                }
            }
            if (rate) {
                // Normalize ('1.0' -> '1', '0.70' -> '0.7') so legacy values
                // and PlayerControls-saved values both match a chip string.
                const parsed = parseFloat(rate);
                if (parsed > 0) setPlaybackRate(String(parsed));
            }
        } catch (e) {}
    };

    const saveTranslationLang = async (code) => {
        setTranslationLang(code);
        try { await AsyncStorage.setItem('@translation_lang', code); } catch (e) {}
    };

    const saveFontSize = async (next) => {
        const clamped = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, next));
        setFontSize(clamped);
        try { await AsyncStorage.setItem('@transcript_font_size', String(clamped)); } catch (e) {}
    };

    const savePlaybackRate = async (rate) => {
        setPlaybackRate(rate);
        try { await AsyncStorage.setItem('@playback_rate', rate); } catch (e) {}
    };

    const savePauseOnLookup = async (on) => {
        setPauseOnLookup(on);
        try { await AsyncStorage.setItem('@pause_on_lookup', on ? '1' : '0'); } catch (e) {}
    };

    const saveAskDeleteOnFinish = async (on) => {
        setAskDeleteOnFinish(on);
        try { await AsyncStorage.setItem(ASK_DELETE_ON_FINISH_KEY, on ? '1' : '0'); } catch (e) {}
    };

    const saveAutoDeleteFinished = async (on) => {
        setAutoDeleteFinished(on);
        try { await AsyncStorage.setItem(AUTO_DELETE_FINISHED_KEY, on ? '1' : '0'); } catch (e) {}
    };

    const savePreference = async (modelId) => {
        try {
            await AsyncStorage.setItem('@whisper_model', modelId);
            setSelectedModel(modelId);
        } catch (e) {}
    };

    const checkModelStatus = async (modelId) => {
        setIsModelDownloaded(await isSherpaModelDownloaded(modelId));
    };

    const handleDownload = async () => {
        setIsDownloading(true);
        setDownloadProgress(0);
        try {
            await ensureSherpaModel(selectedModel, (p) => setDownloadProgress(p));
            setIsModelDownloaded(true);
            const model = SHERPA_MODELS[selectedModel];
            showAlert('Done', `${model.label} model is ready.`);
        } catch (e) {
            showAlert('Download Failed', e?.code === 'NO_SPACE' ? e.message : 'Check your connection and try again.');
        } finally {
            setIsDownloading(false);
        }
    };

    const handleResetQueue = () => {
        showAlert(
            'Reset Transcription Queue',
            'This will cancel all pending and active transcriptions and clear the queue. Use this if the service appears stuck.',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Reset', style: 'destructive', onPress: async () => {
                        await resetService();
                        showAlert('Done', 'Transcription queue has been cleared.');
                    },
                },
            ],
        );
    };

    // ── Dictionaries ─────────────────────────────────────────────────────────
    const refreshInstalledDicts = () => {
        try { setInstalledDicts(getInstalledDictionaries()); } catch (_) { setInstalledDicts([]); }
    };

    // ghToken is the token in use (typed here, else built into the app);
    // storedToken is only what was typed here, so the row can say which.
    const [storedToken, setStoredToken] = useState('');
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const [effective, stored, cached] = await Promise.all([
                getGithubToken(), getStoredGithubToken(), getCachedRemoteDictionaries(),
            ]);
            if (cancelled) return;
            setGhToken(effective);
            setStoredToken(stored);
            setRemoteDicts(cached);
            refreshInstalledDicts();
            // A build with the token baked in lists the repository on its own
            // the first time, so the section is ready to use without a tap.
            if (effective && !cached.length) refreshDictList(effective);
        })();
        const off = onLibraryChange((p) => { if (p?.type === 'dictionaries-changed') refreshInstalledDicts(); });
        return () => { cancelled = true; off(); };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const describeDictError = (e) => {
        if (e?.code === 'AUTH') return e.message;
        if (e?.code === 'OFFLINE') return "Can't reach GitHub. Check your connection.";
        if (e?.code === 'NO_SPACE') return e.message;
        return e?.message || 'Something went wrong.';
    };

    const refreshDictList = async (token = ghToken) => {
        if (!token) { setTokenEditing(true); return; }
        setDictListLoading(true);
        try {
            setRemoteDicts(await listRemoteDictionaries(token));
        } catch (e) {
            showAlert('Dictionaries', describeDictError(e));
        } finally {
            setDictListLoading(false);
        }
    };

    const saveToken = async () => {
        const t = tokenDraft.trim();
        await setGithubToken(t);
        setStoredToken(t);
        const effective = await getGithubToken();
        setGhToken(effective);
        setTokenDraft('');
        setTokenEditing(false);
        if (effective) refreshDictList(effective);
    };

    const removeToken = () => {
        const revert = hasBuiltInToken() ? ' The token built into this app applies again.' : ' Installed dictionaries stay.';
        showAlert('Remove token', `Forget the GitHub token typed on this device?${revert}`, [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Remove', style: 'destructive', onPress: async () => {
                    await setGithubToken('');
                    setStoredToken('');
                    setGhToken(await getGithubToken());
                },
            },
        ]);
    };

    const downloadDict = async (remote) => {
        if (!ghToken) { setTokenEditing(true); return; }
        if (isInstalling(remote.id)) return;
        setDictBusy(b => ({ ...b, [remote.id]: { phase: 'download', percent: 0 } }));
        try {
            await installDictionary(remote, ghToken, (p) => setDictBusy(b => ({ ...b, [remote.id]: p })));
        } catch (e) {
            showAlert('Download failed', `${remote.shortName}: ${describeDictError(e)}`);
        } finally {
            setDictBusy(b => { const { [remote.id]: _gone, ...rest } = b; return rest; });
            refreshInstalledDicts();
        }
    };

    const downloadAllDicts = async () => {
        const missing = remoteDicts.filter(r => !installedDicts.some(d => d.id === r.id));
        for (const r of missing) await downloadDict(r); // one at a time: indexing is CPU-bound
    };

    const removeDict = (d) => {
        showAlert('Remove dictionary', `Delete ${d.shortName} from this device (${formatMB(d.size)})? It can be downloaded again.`, [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete', style: 'destructive', onPress: async () => { await deleteDictionary(d.id); refreshInstalledDicts(); } },
        ]);
    };

    const handleDelete = () => {
        const model = SHERPA_MODELS[selectedModel];
        showAlert(
            'Delete Model',
            `Remove the ${model?.label || selectedModel} model from your device?`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete', style: 'destructive', onPress: async () => {
                        await deleteSherpaModel(selectedModel);
                        setIsModelDownloaded(false);
                    },
                },
            ],
        );
    };

    return (
        <ScrollView style={styles.container} contentContainerStyle={[styles.content, { paddingBottom: bottom + 24 }]}>

            {/* Section: Appearance */}
            <Text style={styles.sectionLabel}>APPEARANCE</Text>

            <View style={styles.card}>
                <View style={styles.themeRow}>
                    {THEME_OPTIONS.map(({ id, label, icon, hint }) => {
                        const palette = THEMES[id];
                        const selected = themeName === id;
                        return (
                            <TouchableOpacity
                                key={id}
                                style={[styles.themeTile, selected && styles.themeTileOn]}
                                onPress={() => setTheme(id)}
                                activeOpacity={0.7}
                                accessibilityRole="radio"
                                accessibilityLabel={`${label} theme. ${hint}`}
                                accessibilityState={{ selected }}
                            >
                                {/* Miniature of the theme: page, a card with two text lines, accent dot */}
                                <View style={[styles.swatch, { backgroundColor: palette.bg, borderColor: palette.hairlineStrong }]}>
                                    <View style={[styles.swatchDot, { backgroundColor: palette.accent }]} />
                                    <View style={[styles.swatchCard, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
                                        <Text style={[styles.swatchAa, { color: palette.textPrimary }]}>Aa</Text>
                                        <View style={[styles.swatchLine, { backgroundColor: palette.transcriptSpoken }]} />
                                        <View style={[styles.swatchLine, styles.swatchLineShort, { backgroundColor: palette.transcriptFuture }]} />
                                    </View>
                                </View>
                                <View style={styles.themeLabelRow}>
                                    <Icon name={icon} size={13} color={selected ? colors.accent : colors.textMuted} />
                                    <Text style={[styles.themeLabel, selected && styles.themeLabelOn]}>{label}</Text>
                                </View>
                                <Text style={styles.themeHint}>{hint}</Text>
                            </TouchableOpacity>
                        );
                    })}
                </View>
            </View>

            {/* Section: Learning */}
            <Text style={styles.sectionLabel}>LEARNING</Text>

            <View style={styles.card}>
                <TouchableOpacity
                    style={[styles.settingRow, styles.rowBorder]}
                    onPress={() => navigation.navigate('Vocabulary')}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel="Open saved vocabulary"
                >
                    <Icon name="bookmark" size={15} color={colors.accent} />
                    <Text style={styles.settingTitle}>Vocabulary</Text>
                    <Icon name="chevron-right" size={15} color={colors.textFaint} style={{ marginLeft: 'auto' }} />
                </TouchableOpacity>

                <View style={[styles.settingBlock, styles.rowBorder]}>
                    <View style={styles.settingHead}>
                        <Icon name="globe" size={15} color={colors.accent} />
                        <Text style={styles.settingTitle}>Translation language</Text>
                    </View>
                    <Text style={[styles.settingHint, styles.indent]}>Tapped words are translated to this language</Text>
                    <View style={[styles.chipWrap, styles.indent]}>
                        {LANGUAGES.map(({ code, label }) => {
                            const selected = translationLang === code;
                            return (
                                <TouchableOpacity
                                    key={code}
                                    style={[styles.chip, selected && styles.chipOn]}
                                    onPress={() => saveTranslationLang(code)}
                                    activeOpacity={0.7}
                                    accessibilityRole="button"
                                    accessibilityLabel={`Translate to ${label}`}
                                    accessibilityState={{ selected }}
                                >
                                    <Text style={[styles.chipText, selected && styles.chipTextOn]}>{label}</Text>
                                </TouchableOpacity>
                            );
                        })}
                    </View>
                </View>

                <View style={[styles.settingRow, styles.rowBorder]}>
                    <View style={{ flex: 1 }}>
                        <View style={styles.settingHead}>
                            <Icon name="pause-circle" size={15} color={colors.accent} />
                            <Text style={styles.settingTitle}>Pause while looking up</Text>
                        </View>
                        <Text style={[styles.settingHint, styles.indent]}>
                            Playback pauses when you open a word or sentence card and resumes when you close it
                        </Text>
                    </View>
                    <Switch
                        value={pauseOnLookup}
                        onValueChange={savePauseOnLookup}
                        trackColor={{ false: colors.surfaceHigh, true: withAlpha(colors.accent, 0.45) }}
                        thumbColor={pauseOnLookup ? colors.accent : colors.textSecondary}
                        ios_backgroundColor={colors.surfaceHigh}
                        accessibilityLabel="Pause playback while looking up a word or sentence"
                    />
                </View>

                <View style={[styles.settingRow, styles.rowBorder]}>
                    <View style={{ flex: 1 }}>
                        <View style={styles.settingHead}>
                            <Icon name="type" size={15} color={colors.accent} />
                            <Text style={styles.settingTitle}>Transcript text size</Text>
                        </View>
                        <Text style={[styles.settingHint, styles.indent]}>{`${FONT_SIZE_MIN}–${FONT_SIZE_MAX} pt`}</Text>
                    </View>
                    <View style={styles.stepper}>
                        <TouchableOpacity
                            style={[styles.stepBtn, fontSize <= FONT_SIZE_MIN && styles.stepBtnDisabled]}
                            onPress={() => saveFontSize(fontSize - 1)}
                            disabled={fontSize <= FONT_SIZE_MIN}
                            accessibilityRole="button"
                            accessibilityLabel="Decrease transcript text size"
                        >
                            <Icon name="minus" size={16} color={fontSize <= FONT_SIZE_MIN ? colors.textFaint : colors.accent} />
                        </TouchableOpacity>
                        <Text style={styles.stepValue}>{fontSize}</Text>
                        <TouchableOpacity
                            style={[styles.stepBtn, fontSize >= FONT_SIZE_MAX && styles.stepBtnDisabled]}
                            onPress={() => saveFontSize(fontSize + 1)}
                            disabled={fontSize >= FONT_SIZE_MAX}
                            accessibilityRole="button"
                            accessibilityLabel="Increase transcript text size"
                        >
                            <Icon name="plus" size={16} color={fontSize >= FONT_SIZE_MAX ? colors.textFaint : colors.accent} />
                        </TouchableOpacity>
                    </View>
                </View>

                <View style={styles.settingBlock}>
                    <View style={styles.settingHead}>
                        <Icon name="fast-forward" size={15} color={colors.accent} />
                        <Text style={styles.settingTitle}>Default playback speed</Text>
                    </View>
                    <View style={[styles.chipWrap, styles.indent]}>
                        {RATES.map((rate) => {
                            const selected = playbackRate === rate;
                            return (
                                <TouchableOpacity
                                    key={rate}
                                    style={[styles.chip, selected && styles.chipOn]}
                                    onPress={() => savePlaybackRate(rate)}
                                    activeOpacity={0.7}
                                    accessibilityRole="button"
                                    accessibilityLabel={`Playback speed ${rate} times`}
                                    accessibilityState={{ selected }}
                                >
                                    <Text style={[styles.chipText, selected && styles.chipTextOn]}>{`${rate}×`}</Text>
                                </TouchableOpacity>
                            );
                        })}
                    </View>
                </View>
            </View>

            {/* Section: Dictionaries */}
            <Text style={styles.sectionLabel}>DICTIONARIES</Text>

            <View style={styles.card}>
                <View style={[styles.settingBlock, styles.rowBorder]}>
                    <View style={styles.settingHead}>
                        <Icon name="key" size={15} color={colors.accent} />
                        <Text style={styles.settingTitle}>GitHub token</Text>
                    </View>
                    <Text style={[styles.settingHint, styles.indent]}>
                        The dictionaries are the MDict files in your private repository {DICTIONARY_SOURCE.owner}/{DICTIONARY_SOURCE.repo}. A personal access token with read access to its contents is needed to list and download them
                        {hasBuiltInToken()
                            ? ' — one is built into this app (.env.local at build time); a token typed here takes precedence.'
                            : '; it is stored only on this device. To skip this step on a fresh install, put it in .env.local before building (see .env.example).'}
                    </Text>
                    {tokenEditing || !ghToken ? (
                        <View style={[styles.tokenRow, styles.indent]}>
                            <TextInput
                                style={styles.tokenInput}
                                value={tokenDraft}
                                onChangeText={setTokenDraft}
                                placeholder="github_pat_… or ghp_…"
                                placeholderTextColor={colors.textFaint}
                                autoCapitalize="none"
                                autoCorrect={false}
                                secureTextEntry
                                accessibilityLabel="GitHub personal access token"
                            />
                            <TouchableOpacity
                                style={[styles.smallBtn, !tokenDraft.trim() && styles.smallBtnDisabled]}
                                onPress={saveToken}
                                disabled={!tokenDraft.trim()}
                                accessibilityRole="button"
                                accessibilityLabel="Save token"
                            >
                                <Text style={styles.smallBtnText}>Save</Text>
                            </TouchableOpacity>
                            {!!ghToken && (
                                <TouchableOpacity style={styles.smallBtnGhost} onPress={() => { setTokenEditing(false); setTokenDraft(''); }} accessibilityRole="button">
                                    <Text style={styles.smallBtnGhostText}>Cancel</Text>
                                </TouchableOpacity>
                            )}
                        </View>
                    ) : (
                        <View style={[styles.tokenRow, styles.indent]}>
                            <Icon name="check-circle" size={14} color={colors.success} />
                            <Text style={styles.tokenSaved}>
                                {maskToken(ghToken)}{!storedToken && hasBuiltInToken() ? ' · built in' : ''}
                            </Text>
                            <TouchableOpacity style={styles.smallBtnGhost} onPress={() => setTokenEditing(true)} accessibilityRole="button">
                                <Text style={styles.smallBtnGhostText}>Change</Text>
                            </TouchableOpacity>
                            {!!storedToken && (
                                <TouchableOpacity style={styles.smallBtnGhost} onPress={removeToken} accessibilityRole="button">
                                    <Text style={[styles.smallBtnGhostText, { color: colors.danger }]}>Remove</Text>
                                </TouchableOpacity>
                            )}
                        </View>
                    )}
                </View>

                {(() => {
                    // Remote list merged with what is on disk, in picker order.
                    const byId = new Map();
                    remoteDicts.forEach(r => byId.set(r.id, { ...r }));
                    installedDicts.forEach(d => byId.set(d.id, { ...(byId.get(d.id) || {}), ...d, installed: true }));
                    const rows = [...byId.values()].sort((a, b) => ((a.order ?? 99) - (b.order ?? 99)) || String(a.name).localeCompare(String(b.name)));
                    if (!rows.length) {
                        return (
                            <View style={styles.settingBlock}>
                                <Text style={[styles.settingHint, styles.indent]}>
                                    {ghToken ? 'Tap “Check for dictionaries” to list the files in the repository.' : 'Save a token, then the list of dictionaries appears here.'}
                                </Text>
                            </View>
                        );
                    }
                    return rows.map((d, idx) => {
                        const busy = dictBusy[d.id];
                        return (
                            <View key={d.id} style={[styles.dictRow, idx < rows.length - 1 && styles.rowBorder]}>
                                <Icon name="book-open" size={15} color={d.installed ? colors.accent : colors.textFaint} />
                                <View style={styles.dictInfo}>
                                    <Text style={[styles.dictName, d.installed && styles.dictNameOn]}>{d.shortName}</Text>
                                    <Text style={styles.dictSub} numberOfLines={1}>
                                        {d.name}{d.size ? ` · ${formatMB(d.size)}` : ''}{d.installed && d.entries ? ` · ${d.entries.toLocaleString()} entries` : ''}
                                    </Text>
                                    {!!busy && (
                                        <View style={styles.miniProgressRow}>
                                            <View style={styles.progressTrack}>
                                                <View style={[styles.progressFill, { width: `${busy.percent ?? 0}%` }]} />
                                            </View>
                                            <Text style={styles.miniProgressLabel}>
                                                {busy.phase === 'index' ? 'Indexing' : 'Downloading'} {busy.percent ?? 0}%
                                            </Text>
                                        </View>
                                    )}
                                </View>
                                {busy ? (
                                    <ActivityIndicator size="small" color={colors.accent} />
                                ) : d.installed ? (
                                    <TouchableOpacity
                                        style={styles.dictIconBtn}
                                        onPress={() => removeDict(d)}
                                        accessibilityRole="button"
                                        accessibilityLabel={`Delete ${d.shortName}`}
                                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                    >
                                        <Icon name="trash-2" size={16} color={colors.danger} />
                                    </TouchableOpacity>
                                ) : (
                                    <TouchableOpacity
                                        style={[styles.dictIconBtn, styles.dictIconBtnAccent]}
                                        onPress={() => downloadDict(d)}
                                        accessibilityRole="button"
                                        accessibilityLabel={`Download ${d.shortName}`}
                                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                    >
                                        <Icon name="arrow-down-circle" size={18} color={colors.accent} />
                                    </TouchableOpacity>
                                )}
                            </View>
                        );
                    });
                })()}
            </View>

            <View style={styles.dictActions}>
                <TouchableOpacity
                    style={[styles.dictActionBtn, (!ghToken || dictListLoading) && styles.dictActionBtnDisabled]}
                    onPress={() => refreshDictList()}
                    disabled={dictListLoading}
                    accessibilityRole="button"
                    accessibilityLabel="Check the repository for dictionaries"
                >
                    {dictListLoading
                        ? <ActivityIndicator size="small" color={colors.accent} />
                        : <Icon name="refresh-cw" size={14} color={colors.accent} />}
                    <Text style={styles.dictActionText}>Check for dictionaries</Text>
                </TouchableOpacity>
                {(() => {
                    const missing = remoteDicts.filter(r => !installedDicts.some(d => d.id === r.id));
                    if (!missing.length || !ghToken) return null;
                    const total = missing.reduce((s, r) => s + (r.size || 0), 0);
                    const anyBusy = Object.keys(dictBusy).length > 0;
                    return (
                        <TouchableOpacity
                            style={[styles.dictActionBtn, anyBusy && styles.dictActionBtnDisabled]}
                            onPress={downloadAllDicts}
                            disabled={anyBusy}
                            accessibilityRole="button"
                            accessibilityLabel="Download all missing dictionaries"
                        >
                            <Icon name="download-cloud" size={14} color={colors.accent} />
                            <Text style={styles.dictActionText}>Download all · {missing.length} · {formatMB(total)}</Text>
                        </TouchableOpacity>
                    );
                })()}
            </View>

            {/* Section: Storage */}
            <Text style={styles.sectionLabel}>STORAGE</Text>

            <View style={styles.card}>
                <View style={[styles.settingRow, styles.rowBorder]}>
                    <View style={{ flex: 1 }}>
                        <View style={styles.settingHead}>
                            <Icon name="trash-2" size={15} color={colors.accent} />
                            <Text style={styles.settingTitle}>Ask to delete finished episodes</Text>
                        </View>
                        <Text style={[styles.settingHint, styles.indent]}>
                            When a downloaded episode plays to the end, offer to delete its download and transcript
                        </Text>
                    </View>
                    <Switch
                        value={askDeleteOnFinish}
                        onValueChange={saveAskDeleteOnFinish}
                        trackColor={{ false: colors.surfaceHigh, true: withAlpha(colors.accent, 0.45) }}
                        thumbColor={askDeleteOnFinish ? colors.accent : colors.textSecondary}
                        ios_backgroundColor={colors.surfaceHigh}
                        accessibilityLabel="Ask to delete a downloaded episode when it finishes"
                    />
                </View>
                <View style={styles.settingRow}>
                    <View style={{ flex: 1 }}>
                        <View style={styles.settingHead}>
                            <Icon name="clock" size={15} color={colors.accent} />
                            <Text style={styles.settingTitle}>Delete finished episodes after a week</Text>
                        </View>
                        <Text style={[styles.settingHint, styles.indent]}>
                            Downloads and transcripts of episodes you finished a week ago and haven't replayed are removed automatically. The episodes stay in your feed, marked as played.
                        </Text>
                    </View>
                    <Switch
                        value={autoDeleteFinished}
                        onValueChange={saveAutoDeleteFinished}
                        trackColor={{ false: colors.surfaceHigh, true: withAlpha(colors.accent, 0.45) }}
                        thumbColor={autoDeleteFinished ? colors.accent : colors.textSecondary}
                        ios_backgroundColor={colors.surfaceHigh}
                        accessibilityLabel="Automatically delete finished episodes that have not been replayed for a week"
                    />
                </View>
            </View>

            {/* Section: Model picker */}
            <Text style={styles.sectionLabel}>TRANSCRIPTION MODEL</Text>

            <View style={styles.infoBanner}>
                <Icon name="info" size={13} color={colors.warning} style={{ marginTop: 1 }} />
                <Text style={styles.infoText}>
                    Transcription runs fully on-device. It consumes significant CPU and battery life.
                </Text>
            </View>

            <View style={styles.card}>
                {MODELS.map((model, idx) => {
                    const selected = selectedModel === model.id;
                    return (
                        <TouchableOpacity
                            key={model.id}
                            style={[
                                styles.modelRow,
                                idx < MODELS.length - 1 && styles.rowBorder,
                            ]}
                            onPress={() => savePreference(model.id)}
                            activeOpacity={0.7}
                            accessibilityRole="radio"
                            accessibilityLabel={`${model.name}, ${model.desc}, ${model.size}`}
                            accessibilityState={{ selected }}
                        >
                            <View style={styles.modelInfo}>
                                <View style={styles.modelNameRow}>
                                    <Text style={[styles.modelName, selected && styles.modelNameActive]}>
                                        {model.name}
                                    </Text>
                                    {model.recommended && (
                                        <View style={styles.badge}>
                                            <Text style={styles.badgeText}>Recommended</Text>
                                        </View>
                                    )}
                                </View>
                                <Text style={styles.modelDesc}>{model.desc}</Text>
                            </View>
                            <View style={styles.modelMeta}>
                                <Text style={styles.modelSize}>{model.size}</Text>
                                <View style={[styles.radio, selected && styles.radioOn]}>
                                    {selected && <View style={styles.radioDot} />}
                                </View>
                            </View>
                        </TouchableOpacity>
                    );
                })}
            </View>

            {/* Section: Status + action */}
            <Text style={styles.sectionLabel}>MODEL STATUS</Text>

            <View style={styles.card}>
                <View style={styles.statusRow}>
                    <Text style={styles.statusName}>{SHERPA_MODELS[selectedModel]?.label || selectedModel}</Text>
                    <View style={[styles.statusPill, isModelDownloaded ? styles.pillGreen : styles.pillRed]}>
                        <Icon
                            name={isModelDownloaded ? 'check' : 'x'}
                            size={11}
                            color={isModelDownloaded ? colors.success : colors.danger}
                        />
                        <Text style={[styles.statusPillText, { color: isModelDownloaded ? colors.success : colors.danger }]}>
                            {isModelDownloaded ? 'Installed' : 'Not installed'}
                        </Text>
                    </View>
                </View>

                {isDownloading && (
                    <View style={styles.progressWrap}>
                        <View style={styles.progressTrack}>
                            <View style={[styles.progressFill, { width: `${downloadProgress}%` }]} />
                        </View>
                        <Text style={styles.progressLabel}>{Math.round(downloadProgress)}%</Text>
                    </View>
                )}
            </View>

            {!isDownloading && (
                isModelDownloaded ? (
                    <TouchableOpacity
                        style={styles.deleteBtn}
                        onPress={handleDelete}
                        accessibilityRole="button"
                        accessibilityLabel="Delete model"
                    >
                        <Icon name="trash-2" size={15} color={colors.danger} />
                        <Text style={styles.deleteBtnText}>Delete model</Text>
                    </TouchableOpacity>
                ) : (
                    <TouchableOpacity
                        style={styles.downloadBtn}
                        onPress={handleDownload}
                        accessibilityRole="button"
                        accessibilityLabel="Download model"
                    >
                        <Icon name="arrow-down-circle" size={16} color={colors.onAccent} />
                        <Text style={styles.downloadBtnText}>Download model</Text>
                    </TouchableOpacity>
                )
            )}

            {/* Section: Troubleshooting */}
            <Text style={styles.sectionLabel}>TROUBLESHOOTING</Text>

            <TouchableOpacity
                style={styles.resetBtn}
                onPress={handleResetQueue}
                accessibilityRole="button"
                accessibilityLabel="Reset transcription queue"
            >
                <Icon name="refresh-cw" size={15} color={colors.warning} />
                <Text style={styles.resetBtnText}>Reset transcription queue</Text>
            </TouchableOpacity>
            <Text style={styles.resetHint}>
                Use this if transcription appears frozen or stuck. Does not delete your existing transcripts.
            </Text>

            {/* Section: Debug Log */}
            <Text style={styles.sectionLabel}>DEBUG</Text>

            <TouchableOpacity
                style={styles.logBtn}
                onPress={() => navigation.navigate('DebugLog')}
                accessibilityRole="button"
                accessibilityLabel="Open debug log"
            >
                <Icon name="file-text" size={15} color={colors.purple} />
                <Text style={styles.logBtnText}>Debug log</Text>
                <Icon name="chevron-right" size={15} color={colors.textFaint} style={{ marginLeft: 'auto' }} />
            </TouchableOpacity>
            <Text style={styles.resetHint}>
                Record UI interactions and service events to diagnose transcription issues.
            </Text>

        </ScrollView>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    content: { paddingTop: 16 },

    // One left edge for everything: section labels, row icons and card text
    // all start 32dp in (card margin 16 + card padding 16). Every row leads
    // with a 15px icon + 10 gap, so titles line up and hints/chips indent by
    // the same 25 under them.
    sectionLabel: {
        ...type.caption,
        fontWeight: '700',
        color: colors.textMuted,
        letterSpacing: 0.7,
        paddingHorizontal: 32,
        marginBottom: 10,
        marginTop: 24,
    },

    infoBanner: {
        flexDirection: 'row',
        gap: 10,
        marginHorizontal: 16,
        marginBottom: 8,
        backgroundColor: withAlpha(colors.warning, 0.07),
        borderRadius: 12,
        padding: 14,
        borderWidth: 0.5,
        borderColor: withAlpha(colors.warning, 0.18),
    },
    infoText: {
        flex: 1,
        ...type.body,
        color: colors.textSecondary,
        lineHeight: 19,
    },

    card: {
        marginHorizontal: 16,
        backgroundColor: colors.surface,
        borderRadius: 14,
        borderWidth: 0.5,
        borderColor: colors.hairline,
        overflow: 'hidden',
    },

    rowBorder: {
        borderBottomWidth: 0.5,
        borderBottomColor: colors.hairlineFaint,
    },

    /* Theme tiles */
    themeRow: { flexDirection: 'row', gap: 10, padding: 12 },
    themeTile: {
        flex: 1,
        borderRadius: 12,
        padding: 8,
        gap: 6,
        borderWidth: 1,
        borderColor: 'transparent',
    },
    themeTileOn: {
        borderColor: colors.accent,
        backgroundColor: withAlpha(colors.accent, 0.06),
    },
    swatch: {
        height: 88,
        borderRadius: 10,
        borderWidth: 0.5,
        padding: 10,
        justifyContent: 'flex-end',
        overflow: 'hidden',
    },
    swatchCard: {
        borderRadius: 8,
        borderWidth: 0.5,
        paddingHorizontal: 9,
        paddingVertical: 7,
        gap: 5,
    },
    swatchAa: { fontSize: 14, fontWeight: '700', letterSpacing: -0.3, lineHeight: 16 },
    swatchLine: { height: 3, borderRadius: 1.5, width: '78%' },
    swatchLineShort: { width: '52%' },
    swatchDot: { position: 'absolute', top: 10, right: 10, width: 10, height: 10, borderRadius: 5 },
    themeLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
    themeLabel: { ...type.title, color: colors.textSecondary },
    themeLabelOn: { color: colors.textPrimary },
    themeHint: { fontSize: 12, color: colors.textMuted, lineHeight: 17 },

    /* Learning rows */
    settingRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 16,
        paddingVertical: 14,
        minHeight: 48,
    },
    settingBlock: {
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 4,
    },
    settingHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    indent: { marginLeft: 25 },
    settingTitle: { ...type.title, color: colors.textPrimary },
    settingHint: { fontSize: 12, color: colors.textMuted, lineHeight: 17 },

    chipWrap: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        marginTop: 8,
    },
    chip: {
        paddingHorizontal: 12,
        minHeight: 32,
        justifyContent: 'center',
        borderRadius: 16,
        backgroundColor: colors.surfaceElevated,
        borderWidth: 0.5,
        borderColor: colors.hairline,
    },
    chipOn: {
        backgroundColor: withAlpha(colors.accent, 0.14),
        borderColor: withAlpha(colors.accent, 0.4),
    },
    chipText: { ...type.label, color: colors.textSecondary },
    chipTextOn: { color: colors.accent, fontWeight: '700' },

    stepper: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    stepBtn: {
        width: 44,
        height: 44,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.surfaceElevated,
        borderWidth: 0.5,
        borderColor: colors.hairline,
    },
    stepBtnDisabled: { opacity: 0.45 },
    stepValue: {
        width: 40,
        textAlign: 'center',
        fontSize: 16,
        fontWeight: '700',
        color: colors.textPrimary,
    },

    /* Model rows */
    modelRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 14,
    },
    modelInfo: { flex: 1 },
    modelNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 3 },
    modelName: { ...type.title, color: colors.textMuted },
    modelNameActive: { color: colors.textPrimary },
    modelDesc: { fontSize: 12, color: colors.textFaint, lineHeight: 17 },

    badge: {
        backgroundColor: withAlpha(colors.success, 0.10),
        borderRadius: 10,
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderWidth: 0.5,
        borderColor: withAlpha(colors.success, 0.25),
    },
    badgeText: { fontSize: 10, fontWeight: '700', color: colors.success },

    modelMeta: { flexDirection: 'row', alignItems: 'center', gap: 14 },
    modelSize: { fontSize: 12, color: colors.textFaint },

    radio: {
        width: 20,
        height: 20,
        borderRadius: 10,
        borderWidth: 1.5,
        borderColor: colors.textFaint,
        alignItems: 'center',
        justifyContent: 'center',
    },
    radioOn: { borderColor: colors.accent },
    radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent },

    /* Status row */
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 16,
    },
    statusName: { fontSize: 14, fontWeight: '600', color: colors.textSecondary },
    statusPill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 20,
    },
    pillGreen: { backgroundColor: withAlpha(colors.success, 0.10) },
    pillRed: { backgroundColor: withAlpha(colors.danger, 0.10) },
    statusPillText: { ...type.label },

    /* Progress */
    progressWrap: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
        paddingBottom: 16,
    },
    progressTrack: {
        flex: 1,
        height: 4,
        backgroundColor: colors.surfaceHigh,
        borderRadius: 2,
        overflow: 'hidden',
    },
    progressFill: { height: 4, backgroundColor: colors.accent, borderRadius: 2 },
    progressLabel: { fontSize: 12, fontWeight: '700', color: colors.accent, width: 34, textAlign: 'right' },

    /* Action buttons */
    downloadBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        backgroundColor: colors.accent,
        marginHorizontal: 16,
        marginTop: 12,
        paddingVertical: 15,
        borderRadius: 14,
    },
    downloadBtnText: { color: colors.onAccent, fontSize: 15, fontWeight: '700' },

    deleteBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        marginHorizontal: 16,
        marginTop: 12,
        paddingVertical: 15,
        borderRadius: 14,
        backgroundColor: withAlpha(colors.danger, 0.08),
        borderWidth: 0.5,
        borderColor: withAlpha(colors.danger, 0.18),
    },
    deleteBtnText: { color: colors.danger, fontSize: 15, fontWeight: '600' },

    resetBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        marginHorizontal: 16,
        marginTop: 10,
        paddingVertical: 15,
        borderRadius: 14,
        backgroundColor: withAlpha(colors.warning, 0.07),
        borderWidth: 0.5,
        borderColor: withAlpha(colors.warning, 0.18),
    },
    resetBtnText: { color: colors.warning, fontSize: 15, fontWeight: '600' },
    resetHint: {
        fontSize: 12,
        color: colors.textFaint,
        textAlign: 'center',
        marginHorizontal: 24,
        marginTop: 10,
        lineHeight: 18,
    },

    /* Dictionaries */
    tokenRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' },
    tokenInput: {
        flex: 1,
        minWidth: 140,
        height: 40,
        paddingHorizontal: 12,
        borderRadius: 10,
        backgroundColor: colors.surfaceElevated,
        borderWidth: 0.5,
        borderColor: colors.hairline,
        color: colors.textPrimary,
        fontSize: 14,
    },
    tokenSaved: { color: colors.textSecondary, fontSize: 13, fontWeight: '600', marginRight: 'auto' },
    smallBtn: {
        paddingHorizontal: 14,
        height: 40,
        justifyContent: 'center',
        borderRadius: 10,
        backgroundColor: colors.accent,
    },
    smallBtnDisabled: { opacity: 0.45 },
    smallBtnText: { color: colors.onAccent, fontSize: 14, fontWeight: '700' },
    smallBtnGhost: {
        paddingHorizontal: 12,
        height: 34,
        justifyContent: 'center',
        borderRadius: 10,
        backgroundColor: colors.surfaceElevated,
        borderWidth: 0.5,
        borderColor: colors.hairline,
    },
    smallBtnGhostText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
    dictRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    dictInfo: { flex: 1 },
    dictName: { ...type.title, color: colors.textMuted },
    dictNameOn: { color: colors.textPrimary },
    dictSub: { fontSize: 12, color: colors.textFaint, lineHeight: 17 },
    miniProgressRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 },
    miniProgressLabel: { fontSize: 11, fontWeight: '700', color: colors.accent, width: 108 },
    dictIconBtn: {
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: withAlpha(colors.danger, 0.08),
    },
    dictIconBtnAccent: { backgroundColor: withAlpha(colors.accent, 0.10) },
    dictActions: { flexDirection: 'row', gap: 10, marginHorizontal: 16, marginTop: 10, flexWrap: 'wrap' },
    dictActionBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingVertical: 11,
        paddingHorizontal: 14,
        borderRadius: 12,
        backgroundColor: withAlpha(colors.accent, 0.08),
        borderWidth: 0.5,
        borderColor: withAlpha(colors.accent, 0.2),
    },
    dictActionBtnDisabled: { opacity: 0.5 },
    dictActionText: { color: colors.accent, fontSize: 14, fontWeight: '600' },

    logBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginHorizontal: 16,
        marginTop: 10,
        paddingVertical: 15,
        paddingHorizontal: 16,
        borderRadius: 14,
        backgroundColor: withAlpha(colors.purple, 0.07),
        borderWidth: 0.5,
        borderColor: withAlpha(colors.purple, 0.18),
    },
    logBtnText: { color: colors.purple, fontSize: 15, fontWeight: '600' },
});

export default SettingsScreen;
