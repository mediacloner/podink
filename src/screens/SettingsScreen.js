import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, ScrollView } from 'react-native';
import { File, Paths } from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { downloadAudioFile } from '../services/downloadService';

const MODELS = [
    { id: 'tiny', name: 'Tiny', size: '~39 MB', desc: 'Fastest transcription, average accuracy.' },
    { id: 'base', name: 'Base', size: '~74 MB', desc: 'Good balance of speed and high accuracy.' },
    { id: 'small', name: 'Small', size: '~241 MB', desc: 'Slower to transcribe, peak accuracy.' }
];

const SettingsScreen = () => {
    const [selectedModel, setSelectedModel] = useState('base');
    const [isModelDownloaded, setIsModelDownloaded] = useState(false);
    const [isDownloading, setIsDownloading] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState(0);

    // Load saved model preference on mount
    useEffect(() => {
        loadPreference();
    }, []);

    // Whenever the selected model changes, check if it's downloaded
    useEffect(() => {
        checkModelStatus(selectedModel);
    }, [selectedModel]);

    const loadPreference = async () => {
        try {
            const saved = await AsyncStorage.getItem('@whisper_model');
            if (saved) {
                setSelectedModel(saved);
            }
        } catch (e) {
            console.error('Failed to load settings', e);
        }
    };

    const savePreference = async (modelId) => {
        try {
            await AsyncStorage.setItem('@whisper_model', modelId);
            setSelectedModel(modelId);
        } catch (e) {
            console.error('Failed to save settings', e);
        }
    };

    const getModelFileName = (modelId) => `ggml-${modelId}.bin`;
    
    const getModelFile = (modelId) => new File(Paths.document, getModelFileName(modelId));

    const checkModelStatus = (modelId) => {
        const file = getModelFile(modelId);
        setIsModelDownloaded(file.exists);
    };

    const handleDownloadModel = async () => {
        setIsDownloading(true);
        setDownloadProgress(0);
        
        const fileName = getModelFileName(selectedModel);
        const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${fileName}`;
        
        try {
            await downloadAudioFile(url, fileName, (progress) => {
                setDownloadProgress(progress);
            });
            setIsModelDownloaded(true);
            Alert.alert("Success", `${selectedModel.toUpperCase()} model downloaded successfully.`);
        } catch (error) {
            console.error('Download failed', error);
            Alert.alert("Error", "Failed to download the AI model.");
        } finally {
            setIsDownloading(false);
        }
    };

    const handleDeleteModel = async () => {
        Alert.alert("Delete AI Model", `Are you sure you want to remove the ${selectedModel} model from your device? Transcriptions using this model will be disabled until you download it again.`, [
            { text: "Cancel", style: "cancel" },
            { text: "Delete", style: "destructive", onPress: () => {
                const file = getModelFile(selectedModel);
                if (file.exists) {
                    file.delete();
                }
                setIsModelDownloaded(false);
            }}
        ]);
    };

    return (
        <ScrollView style={styles.container}>
            <View style={styles.card}>
                 <Text style={styles.title}>Transcription AI Model</Text>
                 <Text style={styles.description}>
                     Podink requires an offline Whisper ML model to generate transcriptions locally. 
                     Choose your preferred balance of speed vs accuracy.
                 </Text>
                 <Text style={styles.warning}>
                     ⚠️ Warning: Running local transcription is CPU-intensive. It consumes significant battery life and may cause your device to run warm.
                 </Text>
                 
                 <Text style={styles.subtitle}>Select Default Model:</Text>
                 <View style={styles.modelList}>
                     {MODELS.map((model) => (
                         <TouchableOpacity 
                             key={model.id} 
                             style={[styles.modelOption, selectedModel === model.id && styles.modelOptionSelected]} 
                             onPress={() => savePreference(model.id)}
                         >
                             <View style={styles.modelHeaderRow}>
                                 <Text style={[styles.modelName, selectedModel === model.id && styles.modelNameSelected]}>{model.name}</Text>
                                 <Text style={styles.modelSize}>{model.size}</Text>
                             </View>
                             <Text style={styles.modelDesc}>{model.desc}</Text>
                         </TouchableOpacity>
                     ))}
                 </View>
                
                 <View style={styles.statusBox}>
                     <Text style={styles.statusText}>
                         {selectedModel.toUpperCase()} Model Status: {isModelDownloaded ? 'Installed' : 'Not Installed'}
                     </Text>
                 </View>

                 {isDownloading ? (
                     <View style={styles.progressContainer}>
                         <ActivityIndicator size="small" color="#4a90e2" style={{ marginRight: 10 }} />
                         <Text style={styles.progressText}>{downloadProgress.toFixed(1)}%</Text>
                     </View>
                 ) : isModelDownloaded ? (
                     <TouchableOpacity style={[styles.btn, styles.deleteBtn]} onPress={handleDeleteModel}>
                         <Text style={styles.btnText}>Delete {selectedModel} Model</Text>
                     </TouchableOpacity>
                 ) : (
                     <TouchableOpacity style={[styles.btn, styles.downloadBtn]} onPress={handleDownloadModel}>
                         <Text style={styles.btnText}>Download {selectedModel} Model</Text>
                     </TouchableOpacity>
                 )}
            </View>
            <View style={{height: 50}} />
        </ScrollView>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#121212', padding: 20 },
    card: { backgroundColor: '#1e1e1e', padding: 20, borderRadius: 10 },
    title: { color: '#fff', fontSize: 18, fontWeight: 'bold', marginBottom: 10 },
    subtitle: { color: '#fff', fontSize: 16, fontWeight: '600', marginTop: 15, marginBottom: 10 },
    description: { color: '#bbb', fontSize: 14, marginBottom: 15, lineHeight: 20 },
    warning: { color: '#e2a44a', fontSize: 13, marginBottom: 20, lineHeight: 18, backgroundColor: '#3a2d1a', padding: 10, borderRadius: 5 },
    
    modelList: { marginBottom: 20 },
    modelOption: { backgroundColor: '#2a2a2a', padding: 15, borderRadius: 8, marginBottom: 10, borderWidth: 1, borderColor: '#333' },
    modelOptionSelected: { borderColor: '#4a90e2', backgroundColor: '#1a2a3a' },
    modelHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5 },
    modelName: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
    modelNameSelected: { color: '#4a90e2' },
    modelSize: { color: '#888', fontSize: 14 },
    modelDesc: { color: '#aaa', fontSize: 13, lineHeight: 18 },

    statusBox: { padding: 10, backgroundColor: '#333', borderRadius: 5, marginBottom: 20 },
    statusText: { color: '#fff', fontWeight: 'bold' },
    btn: { paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
    downloadBtn: { backgroundColor: '#4a90e2' },
    deleteBtn: { backgroundColor: '#e24a4a' },
    btnText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
    progressContainer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 12 },
    progressText: { color: '#4a90e2', fontWeight: 'bold' }
});

export default SettingsScreen;
