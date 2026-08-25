import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    FlatList, Platform, Share, StyleSheet,
    Switch, Text, TouchableOpacity, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather as Icon } from '@expo/vector-icons';
import {
    getLogs, clearLogs, onLogsChange,
    isLoggingEnabled, setLoggingEnabled, exportLogsAsText,
} from '../services/logService';
import { showAlert } from '../components/AppAlert';
import { colors, withAlpha } from '../theme';

// ─── Category badge colours ──────────────────────────────────────────────────

const CAT_COLORS = {
    UI:      { bg: withAlpha(colors.accent, 0.12),  fg: colors.accent },
    SERVICE: { bg: withAlpha(colors.success, 0.12), fg: colors.success },
    QUEUE:   { bg: withAlpha(colors.warning, 0.12), fg: colors.warning },
    SYSTEM:  { bg: withAlpha(colors.purple, 0.12),  fg: colors.purple },
};

const formatTime = (ts) => {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
};

const formatDate = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ─── Log entry row ───────────────────────────────────────────────────────────

const LogEntry = React.memo(({ item }) => {
    const cat = CAT_COLORS[item.cat] || CAT_COLORS.SYSTEM;
    const hasData = item.data !== undefined;
    const [expanded, setExpanded] = useState(false);

    return (
        <TouchableOpacity
            style={s.entry}
            onPress={() => hasData && setExpanded(p => !p)}
            activeOpacity={hasData ? 0.6 : 1}
            disabled={!hasData}
        >
            <View style={s.entryHeader}>
                <Text style={s.time}>{formatTime(item.ts)}</Text>
                <View style={[s.catBadge, { backgroundColor: cat.bg }]}>
                    <Text style={[s.catText, { color: cat.fg }]}>{item.cat}</Text>
                </View>
                <Text style={s.msg} numberOfLines={expanded ? 0 : 1}>{item.msg}</Text>
                {hasData && (
                    <Icon
                        name={expanded ? 'chevron-up' : 'chevron-down'}
                        size={12}
                        color={colors.textFaint}
                    />
                )}
            </View>
            {expanded && hasData && (
                <Text style={s.data}>{JSON.stringify(item.data, null, 2)}</Text>
            )}
        </TouchableOpacity>
    );
});

// ─── Screen ──────────────────────────────────────────────────────────────────

const LogScreen = ({ navigation }) => {
    const { bottom } = useSafeAreaInsets();
    const [logs, setLogs]       = useState(getLogs);
    const [enabled, setEnabled] = useState(isLoggingEnabled);
    const listRef = useRef(null);

    useEffect(() => {
        navigation.setOptions({
            headerStyle:      { backgroundColor: colors.bg },
            headerTintColor:  colors.textPrimary,
            headerTitleStyle: { fontWeight: '700', fontSize: 17, letterSpacing: -0.3 },
            headerShadowVisible: false,
            title: 'Debug Log',
        });
    }, [navigation]);

    const refresh = useCallback(() => {
        setLogs([...getLogs()]);
        setEnabled(isLoggingEnabled());
    }, []);

    useEffect(() => {
        const unsub = onLogsChange(refresh);
        return unsub;
    }, [refresh]);

    const handleToggle = async (val) => {
        await setLoggingEnabled(val);
        setEnabled(val);
    };

    const handleClear = () => {
        showAlert('Clear Logs', 'Delete all log entries?', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Clear', style: 'destructive', onPress: async () => {
                await clearLogs();
                refresh();
            }},
        ]);
    };

    const handleExport = async () => {
        const text = exportLogsAsText();
        if (!text || text === '[]') {
            showAlert('Empty', 'No log entries to export.');
            return;
        }
        try {
            await Share.share({
                title: `podink-debug-${formatDate(Date.now())}.json`,
                message: text,
                ...(Platform.OS === 'android' ? {} : { url: undefined }),
            });
        } catch (_) {}
    };

    const scrollToBottom = () => {
        if (logs.length > 0 && listRef.current) {
            listRef.current.scrollToEnd({ animated: true });
        }
    };

    return (
        <View style={s.container}>
            {/* Toggle + actions bar */}
            <View style={s.toolbar}>
                <View style={s.toggleRow}>
                    <Icon name="activity" size={15} color={enabled ? colors.success : colors.textFaint} />
                    <Text style={[s.toggleLabel, enabled && s.toggleLabelOn]}>
                        {enabled ? 'Logging active' : 'Logging disabled'}
                    </Text>
                    <Switch
                        value={enabled}
                        onValueChange={handleToggle}
                        trackColor={{ false: colors.surfaceElevated, true: withAlpha(colors.success, 0.35) }}
                        thumbColor={enabled ? colors.success : colors.textMuted}
                    />
                </View>

                <View style={s.actionRow}>
                    <TouchableOpacity style={s.actionBtn} onPress={scrollToBottom} accessibilityRole="button" accessibilityLabel="Scroll to latest log entry">
                        <Icon name="arrow-down" size={14} color={colors.accent} />
                        <Text style={s.actionBtnText}>Latest</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={s.actionBtn} onPress={handleClear} accessibilityRole="button" accessibilityLabel="Clear logs">
                        <Icon name="trash-2" size={14} color={colors.danger} />
                        <Text style={[s.actionBtnText, { color: colors.danger }]}>Clear</Text>
                    </TouchableOpacity>
                </View>
            </View>

            {/* Log list */}
            {logs.length === 0 ? (
                <View style={s.empty}>
                    <Icon name="file-text" size={32} color={colors.surfaceElevated} />
                    <Text style={s.emptyText}>
                        {enabled ? 'No entries yet — interact with the app' : 'Enable logging to start capturing events'}
                    </Text>
                </View>
            ) : (
                <FlatList
                    ref={listRef}
                    data={logs}
                    keyExtractor={(_, i) => String(i)}
                    renderItem={({ item }) => <LogEntry item={item} />}
                    contentContainerStyle={{ paddingBottom: bottom + 100 }}
                    initialScrollIndex={Math.max(0, logs.length - 1)}
                    getItemLayout={(_, i) => ({ length: 44, offset: 44 * i, index: i })}
                    onScrollToIndexFailed={() => {}}
                />
            )}

            {/* Export button — fixed at bottom */}
            <View style={[s.exportBar, { paddingBottom: bottom + 16 }]}>
                <TouchableOpacity style={s.exportBtn} onPress={handleExport} accessibilityRole="button" accessibilityLabel="Export log">
                    <Icon name="share" size={16} color={colors.textPrimary} />
                    <Text style={s.exportBtnText}>Export log</Text>
                </TouchableOpacity>
            </View>
        </View>
    );
};

// ─── Styles ──────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },

    toolbar: {
        borderBottomWidth: 0.5,
        borderBottomColor: colors.hairline,
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 10,
    },
    toggleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    toggleLabel:   { flex: 1, fontSize: 14, fontWeight: '600', color: colors.textMuted },
    toggleLabelOn: { color: colors.success },

    actionRow: { flexDirection: 'row', gap: 12 },
    actionBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 10,
        backgroundColor: colors.surface,
        borderWidth: 0.5,
        borderColor: colors.hairline,
    },
    actionBtnText: { fontSize: 12, fontWeight: '600', color: colors.accent },

    /* Entries */
    entry: {
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderBottomWidth: 0.5,
        borderBottomColor: colors.hairlineFaint,
    },
    entryHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    time: { fontSize: 10, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', color: colors.textFaint, width: 80 },
    catBadge: {
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 6,
    },
    catText: { fontSize: 9, fontWeight: '800', letterSpacing: 0.3 },
    msg: { flex: 1, fontSize: 12, color: colors.textSecondary },
    data: {
        marginTop: 6,
        marginLeft: 88,
        fontSize: 11,
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
        color: colors.textMuted,
        lineHeight: 17,
    },

    /* Empty state */
    empty: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        paddingHorizontal: 40,
    },
    emptyText: { fontSize: 14, color: colors.textFaint, textAlign: 'center', lineHeight: 21 },

    /* Export bar */
    exportBar: {
        position: 'absolute',
        bottom: 0, left: 0, right: 0,
        paddingHorizontal: 16,
        paddingTop: 12,
        backgroundColor: withAlpha(colors.bg, 0.92),
        borderTopWidth: 0.5,
        borderTopColor: colors.hairline,
    },
    exportBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        backgroundColor: colors.accent,
        paddingVertical: 15,
        borderRadius: 14,
    },
    exportBtnText: { color: colors.textPrimary, fontSize: 15, fontWeight: '700' },
});

export default LogScreen;
