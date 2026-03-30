import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { downloadAudioFile } from '../services/downloadService';

const MODEL_FILE_NAME = 'ggml-tiny.bin';
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILE_NAME}`;

const SettingsScreen = () => {
    const [isModelDownloaded, setIsModelDownloaded] = useState(false);
    const [isDownloading, setIsDownloading] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState(0);

    useEffect(() => {
        checkModelStatus();
    }, []);

    const getModelFile = () => new File(Paths.document, MODEL_FILE_NAME);

    const checkModelStatus = () => {
        const file = getModelFile();
        setIsModelDownloaded(file.exists);
    };

    const handleDownloadModel = async () => {
        setIsDownloading(true);
        setDownloadProgress(0);
        
        try {
            await downloadAudioFile(MODEL_URL, MODEL_FILE_NAME, (progress) => {
                setDownloadProgress(progress);
            });
            setIsModelDownloaded(true);
            Alert.alert("Success", "Whisper model downloaded successfully.");
        } catch (error) {
            console.error('Download failed', error);
            Alert.alert("Error", "Failed to download the AI model.");
        } finally {
            setIsDownloading(false);
        }
    };

    const handleDeleteModel = async () => {
        Alert.alert("Delete AI Model", "Are you sure you want to remove the ~75MB Whisper model from your device? Transcriptions will be disabled until you download it again.", [
            { text: "Cancel", style: "cancel" },
            { text: "Delete", style: "destructive", onPress: () => {
                const file = getModelFile();
                if (file.exists) {
                    file.delete();
                }
                setIsModelDownloaded(false);
            }}
        ]);
    };

    return (
        <View style={styles.container}>
            <View style={styles.card}>
                 <Text style={styles.title}>Transcription AI Model</Text>
                 <Text style={styles.description}>
                     Podink requires an offline Whisper ML model (Tiny version, ~75MB) to generate transcriptions locally. 
                 </Text>
                 <Text style={styles.warning}>
                     ⚠️ Warning: Running local transcription is CPU-intensive. It consumes significant battery life and may cause your device to run warm.
                 </Text>
                
                 <View style={styles.statusBox}>
                     <Text style={styles.statusText}>
                         Status: {isModelDownloaded ? 'Installed' : 'Not Installed'}
                     </Text>
                 </View>

                 {isDownloading ? (
                     <View style={styles.progressContainer}>
                         <ActivityIndicator size="small" color="#4a90e2" style={{ marginRight: 10 }} />
                         <Text style={styles.progressText}>{downloadProgress.toFixed(1)}%</Text>
                     </View>
                 ) : isModelDownloaded ? (
                     <TouchableOpacity style={[styles.btn, styles.deleteBtn]} onPress={handleDeleteModel}>
                         <Text style={styles.btnText}>Delete Model</Text>
                     </TouchableOpacity>
                 ) : (
                     <TouchableOpacity style={[styles.btn, styles.downloadBtn]} onPress={handleDownloadModel}>
                         <Text style={styles.btnText}>Download Model</Text>
                     </TouchableOpacity>
                 )}
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#121212', padding: 20 },
    card: { backgroundColor: '#1e1e1e', padding: 20, borderRadius: 10 },
    title: { color: '#fff', fontSize: 18, fontWeight: 'bold', marginBottom: 10 },
    description: { color: '#bbb', fontSize: 14, marginBottom: 15, lineHeight: 20 },
    warning: { color: '#e2a44a', fontSize: 13, marginBottom: 20, lineHeight: 18, backgroundColor: '#3a2d1a', padding: 10, borderRadius: 5 },
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
