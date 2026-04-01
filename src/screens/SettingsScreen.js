import React, { useState, useEffect } from 'react';
import {
    Platform, View, Text, TouchableOpacity,
    StyleSheet, Alert, ActivityIndicator, ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { File, Paths } from 'expo-file-system';
import { Feather as Icon } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { downloadAudioFile } from '../services/downloadService';

const ALL_MODELS = [
    { id: 'tiny',       name: 'Tiny',     size: '39 MB',  desc: 'Fastest, lower accuracy' },
    { id: 'base',       name: 'Base',     size: '74 MB',  desc: 'Best balance of speed and accuracy', recommended: true },
    { id: 'base.q8_0',  name: 'Base Q8',  size: '39 MB',  desc: 'Same quality as Base, ~2× faster', ios: true },
    { id: 'small',      name: 'Small',    size: '241 MB', desc: 'Highest accuracy, slower' },
    { id: 'small.q8_0', name: 'Small Q8', size: '120 MB', desc: 'Same quality as Small, ~2× faster', ios: true },
];

const MODELS = Platform.OS === 'android' ? ALL_MODELS.filter(m => !m.ios) : ALL_MODELS;

const SettingsScreen = () => {
    const { bottom } = useSafeAreaInsets();
    const [selectedModel, setSelectedModel]     = useState('base');
    const [isModelDownloaded, setIsModelDownloaded] = useState(false);
    const [isDownloading, setIsDownloading]     = useState(false);
    const [downloadProgress, setDownloadProgress] = useState(0);

    useEffect(() => { loadPreference(); }, []);
    useEffect(() => { checkModelStatus(selectedModel); }, [selectedModel]);

    const loadPreference = async () => {
        try {
            const saved = await AsyncStorage.getItem('@whisper_model');
            if (saved) setSelectedModel(saved);
        } catch (e) {}
    };

    const savePreference = async (modelId) => {
        try {
            await AsyncStorage.setItem('@whisper_model', modelId);
            setSelectedModel(modelId);
        } catch (e) {}
    };

    const getModelFile = (modelId) => new File(Paths.document, `ggml-${modelId}.bin`);

    const checkModelStatus = (modelId) => {
        setIsModelDownloaded(getModelFile(modelId).exists);
    };

    const handleDownload = async () => {
        setIsDownloading(true);
        setDownloadProgress(0);
        const fileName = `ggml-${selectedModel}.bin`;
        const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${fileName}`;
        try {
            await downloadAudioFile(url, fileName, (p) => setDownloadProgress(p));
            setIsModelDownloaded(true);
            Alert.alert('Done', `${selectedModel} model is ready.`);
        } catch {
            Alert.alert('Download Failed', 'Check your connection and try again.');
        } finally {
            setIsDownloading(false);
        }
    };

    const handleDelete = () => {
        Alert.alert(
            'Delete Model',
            `Remove the ${selectedModel} model from your device?`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete', style: 'destructive', onPress: () => {
                        const file = getModelFile(selectedModel);
                        if (file.exists) file.delete();
                        setIsModelDownloaded(false);
                    }
                }
            ]
        );
    };

    return (
        <ScrollView style={styles.container} contentContainerStyle={[styles.content, { paddingBottom: bottom + 58 }]}>

            {/* Section: Model picker */}
            <Text style={styles.sectionLabel}>TRANSCRIPTION MODEL</Text>

            <View style={styles.infoBanner}>
                <Icon name="info" size={13} color="#FF9F0A" style={{ marginTop: 1 }} />
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
                                idx < MODELS.length - 1 && styles.modelRowBorder,
                            ]}
                            onPress={() => savePreference(model.id)}
                            activeOpacity={0.7}
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
                    <Text style={styles.statusName}>{selectedModel}</Text>
                    <View style={[styles.statusPill, isModelDownloaded ? styles.pillGreen : styles.pillRed]}>
                        <Icon
                            name={isModelDownloaded ? 'check' : 'x'}
                            size={11}
                            color={isModelDownloaded ? '#34C759' : '#FF453A'}
                        />
                        <Text style={[styles.statusPillText, { color: isModelDownloaded ? '#34C759' : '#FF453A' }]}>
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
                    <TouchableOpacity style={styles.deleteBtn} onPress={handleDelete}>
                        <Icon name="trash-2" size={15} color="#FF453A" />
                        <Text style={styles.deleteBtnText}>Delete model</Text>
                    </TouchableOpacity>
                ) : (
                    <TouchableOpacity style={styles.downloadBtn} onPress={handleDownload}>
                        <Icon name="arrow-down-circle" size={16} color="#fff" />
                        <Text style={styles.downloadBtnText}>Download model</Text>
                    </TouchableOpacity>
                )
            )}

        </ScrollView>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#0C0C0E' },
    content:   { paddingTop: 16 },

    sectionLabel: {
        fontSize: 11,
        fontWeight: '700',
        color: '#636366',
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
        backgroundColor: 'rgba(255,159,10,0.07)',
        borderRadius: 12,
        padding: 14,
        borderWidth: 0.5,
        borderColor: 'rgba(255,159,10,0.18)',
    },
    infoText: {
        flex: 1,
        fontSize: 13,
        color: '#AEAEB2',
        lineHeight: 19,
    },

    card: {
        marginHorizontal: 16,
        backgroundColor: '#141416',
        borderRadius: 14,
        borderWidth: 0.5,
        borderColor: 'rgba(255,255,255,0.07)',
        overflow: 'hidden',
    },

    /* Model rows */
    modelRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 14,
    },
    modelRowBorder: {
        borderBottomWidth: 0.5,
        borderBottomColor: 'rgba(255,255,255,0.06)',
    },
    modelInfo: { flex: 1 },
    modelNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 3 },
    modelName: { fontSize: 15, fontWeight: '600', color: '#636366' },
    modelNameActive: { color: '#FFFFFF' },
    modelDesc: { fontSize: 12, color: '#3A3A3C', lineHeight: 17 },

    badge: {
        backgroundColor: 'rgba(52,199,89,0.10)',
        borderRadius: 10,
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderWidth: 0.5,
        borderColor: 'rgba(52,199,89,0.25)',
    },
    badgeText: { fontSize: 10, fontWeight: '700', color: '#34C759' },

    modelMeta: { flexDirection: 'row', alignItems: 'center', gap: 14 },
    modelSize: { fontSize: 12, color: '#3A3A3C' },

    radio: {
        width: 20,
        height: 20,
        borderRadius: 10,
        borderWidth: 1.5,
        borderColor: '#3A3A3C',
        alignItems: 'center',
        justifyContent: 'center',
    },
    radioOn: { borderColor: '#4FACFE' },
    radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#4FACFE' },

    /* Status row */
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 16,
    },
    statusName: { fontSize: 14, fontWeight: '600', color: '#AEAEB2' },
    statusPill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 20,
    },
    pillGreen: { backgroundColor: 'rgba(52,199,89,0.10)' },
    pillRed:   { backgroundColor: 'rgba(255,69,58,0.10)' },
    statusPillText: { fontSize: 12, fontWeight: '600' },

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
        backgroundColor: '#1E1E20',
        borderRadius: 2,
        overflow: 'hidden',
    },
    progressFill: { height: 4, backgroundColor: '#4FACFE', borderRadius: 2 },
    progressLabel: { fontSize: 12, fontWeight: '700', color: '#4FACFE', width: 34, textAlign: 'right' },

    /* Action buttons */
    downloadBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        backgroundColor: '#4FACFE',
        marginHorizontal: 16,
        marginTop: 12,
        paddingVertical: 15,
        borderRadius: 14,
    },
    downloadBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },

    deleteBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        marginHorizontal: 16,
        marginTop: 12,
        paddingVertical: 15,
        borderRadius: 14,
        backgroundColor: 'rgba(255,69,58,0.08)',
        borderWidth: 0.5,
        borderColor: 'rgba(255,69,58,0.18)',
    },
    deleteBtnText: { color: '#FF453A', fontSize: 15, fontWeight: '600' },
});

export default SettingsScreen;
