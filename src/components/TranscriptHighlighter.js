import React, { useRef, useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useProgress } from 'react-native-track-player';

const TranscriptHighlighter = ({ segments }) => {
    const { position } = useProgress(); // Position in seconds
    const scrollViewRef = useRef(null);

    // Filter to find the active segment based on current playback position
    const activeIndex = segments.findIndex(
        (seg) => position * 1000 >= seg.start && position * 1000 <= seg.end
    );

    // Auto-scroll logic (basic approach)
    useEffect(() => {
        if (activeIndex > -1 && scrollViewRef.current) {
             // Rough scrolling estimation per line, usually requires measuring for precision
            scrollViewRef.current.scrollTo({ y: activeIndex * 40, animated: true });
        }
    }, [activeIndex]);

    if (!segments || segments.length === 0) {
        return (
            <View style={styles.container}>
                 <Text style={styles.placeholder}>No Transcript Available</Text>
            </View>
        );
    }

    return (
        <ScrollView style={styles.container} ref={scrollViewRef}>
            {segments.map((segment, index) => {
                const isActive = index === activeIndex;
                return (
                    <Text 
                        key={index}
                        style={[styles.text, isActive && styles.activeText]}
                    >
                        {segment.text}
                    </Text>
                );
            })}
        </ScrollView>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1, padding: 20 },
    text: { fontSize: 24, color: '#666', marginBottom: 15, lineHeight: 32 },
    activeText: { color: '#fff', fontWeight: 'bold' },
    placeholder: { fontSize: 16, color: '#aaa', textAlign: 'center', marginTop: 50 }
});

export default TranscriptHighlighter;
