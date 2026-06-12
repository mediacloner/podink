import React, { useState, useEffect } from 'react';
import {
    View, Text, TouchableOpacity,
    StyleSheet, ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Feather as Icon } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SHERPA_MODELS, ensureSherpaModel, isSherpaModelDownloaded, deleteSherpaModel } from '../services/downloadService';
import { resetService } from '../services/whisperService';
import { showAlert } from '../components/AppAlert';
import { colors, withAlpha, type } from '../theme';

// Learning-focused copy overrides for the model picker.
const MODEL_COPY = {
    whisper_tiny_en: 'Word-by-word highlighting — best for learning',
    sensevoice_small: 'Powerful multilingual (50+ languages) · larger download · evaluation',
};

const DEFAULT_MODEL_KEY = SHERPA_MODELS.whisper_tiny_en ? 'whisper_tiny_en' : Object.keys(SHERPA_MODELS)[0];

const MODELS = Object.entries(SHERPA_MODELS).map(([id, m]) => ({
    id,
    name: m.label,
    size: `~${m.totalSizeMB} MB`,
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

const SettingsScreen = () => {
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

    useEffect(() => { loadPreference(); loadLearningPrefs(); }, []);
    useEffect(() => { checkModelStatus(selectedModel); }, [selectedModel]);

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
            const [lang, size, rate] = await Promise.all([
                AsyncStorage.getItem('@translation_lang'),
                AsyncStorage.getItem('@transcript_font_size'),
                AsyncStorage.getItem('@playback_rate'),
            ]);
            if (lang) setTranslationLang(lang);
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
        } catch {
            showAlert('Download Failed', 'Check your connection and try again.');
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
        <ScrollView style={styles.container} contentContainerStyle={[styles.content, { paddingBottom: bottom + 58 }]}>

            {/* Section: Learning */}
            <Text style={styles.sectionLabel}>LEARNING</Text>

            <View style={styles.card}>
                <TouchableOpacity
                    style={[styles.settingRow, styles.rowBorder]}
                    onPress={() => navigation.getParent()?.navigate('Vocabulary')}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel="Open saved vocabulary"
                >
                    <Icon name="bookmark" size={15} color={colors.accent} />
                    <Text style={styles.settingTitle}>Vocabulary</Text>
                    <Icon name="chevron-right" size={15} color={colors.textFaint} style={{ marginLeft: 'auto' }} />
                </TouchableOpacity>

                <View style={[styles.settingBlock, styles.rowBorder]}>
                    <Text style={styles.settingTitle}>Translation language</Text>
                    <Text style={styles.settingHint}>Tapped words are translated to this language</Text>
                    <View style={styles.chipWrap}>
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
                        <Text style={styles.settingTitle}>Transcript text size</Text>
                        <Text style={styles.settingHint}>{`${FONT_SIZE_MIN}–${FONT_SIZE_MAX} pt`}</Text>
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
                    <Text style={styles.settingTitle}>Default playback speed</Text>
                    <View style={styles.chipWrap}>
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
                        <Icon name="arrow-down-circle" size={16} color={colors.textPrimary} />
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
                onPress={() => navigation.getParent()?.navigate('DebugLog')}
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

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    content: { paddingTop: 16 },

    sectionLabel: {
        ...type.caption,
        fontWeight: '700',
        color: colors.textMuted,
        letterSpacing: 0.7,
        paddingHorizontal: 20,
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
    downloadBtnText: { color: colors.textPrimary, fontSize: 15, fontWeight: '700' },

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

    logBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginHorizontal: 16,
        marginTop: 10,
        paddingVertical: 15,
        paddingHorizontal: 18,
        borderRadius: 14,
        backgroundColor: withAlpha(colors.purple, 0.07),
        borderWidth: 0.5,
        borderColor: withAlpha(colors.purple, 0.18),
    },
    logBtnText: { color: colors.purple, fontSize: 15, fontWeight: '600' },
});

export default SettingsScreen;
