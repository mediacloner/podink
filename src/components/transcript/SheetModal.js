import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    Animated, Modal, PanResponder, Pressable, ScrollView,
    StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { Feather as Icon } from '@expo/vector-icons';
import { radii, withAlpha, useTheme, useStyles } from '../../theme';

// Swipe-down-to-close thresholds: past this drag distance or fling speed
// the sheet dismisses; anything less springs back into place.
const CLOSE_DISTANCE = 120;
const CLOSE_VELOCITY = 0.8;

const springBack = (value) =>
    Animated.spring(value, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();

// Bottom sheet shared by the translation and word-lookup cards.
//
// Swipe-down works anywhere on the card, not just outside it. Two things
// make that hold:
//  - The drag lives on a plain Animated.View. It used to sit on a Pressable,
//    but Pressable spreads its own responder handlers AFTER any props, so
//    the PanResponder's move/release handlers were silently replaced and the
//    drag never moved or closed anything. The backdrop is now a sibling
//    behind the card, so taps on the card can't reach it and no swallowing
//    Pressable is needed.
//  - The body ScrollView is only scroll-enabled while its content actually
//    overflows. Android's ScrollView intercepts every vertical drag once it
//    can scroll and wins the race against the JS responder system; with
//    scrolling off for short content (the common case) the card gets the
//    gesture. Long content still dismisses from the header, the footer
//    button, the backdrop, or the back button.
const SheetModal = ({ visible, onClose, header, footer, children, maxHeight = '85%' }) => {
    const st = useStyles(makeStyles);
    const translateY = useRef(new Animated.Value(0)).current;
    const scrollOffsetRef = useRef(0);
    const sizesRef = useRef({ content: 0, viewport: 0 });
    const [canScroll, setCanScroll] = useState(false);

    // The PanResponder is created once and freezes its closure; mirror the
    // latest onClose so releasing a drag always calls the current handler.
    const onCloseRef = useRef(onClose);
    useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

    // A dismissed sheet keeps its dragged offset — reset before re-opening.
    useEffect(() => {
        if (visible) {
            translateY.setValue(0);
            scrollOffsetRef.current = 0;
        }
    }, [visible, translateY]);

    const updateCanScroll = useCallback(() => {
        const { content, viewport } = sizesRef.current;
        const next = viewport > 0 && content > viewport + 1;
        if (!next) scrollOffsetRef.current = 0; // nothing to be scrolled away from
        setCanScroll(next);
    }, []);

    const dragResponder = useRef(PanResponder.create({
        // Capture downward drags only while the body is scrolled to the top,
        // so a scrollable body keeps normal scrolling in every other case.
        onMoveShouldSetPanResponderCapture: (_, g) =>
            scrollOffsetRef.current <= 0 && g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx) * 1.5,
        onPanResponderTerminationRequest: () => false,
        onPanResponderMove: (_, g) => translateY.setValue(Math.max(0, g.dy)),
        onPanResponderRelease: (_, g) => {
            if (g.dy > CLOSE_DISTANCE || g.vy > CLOSE_VELOCITY) onCloseRef.current?.();
            else springBack(translateY);
        },
        onPanResponderTerminate: () => springBack(translateY),
    })).current;

    return (
        <Modal visible={visible} transparent animationType='slide' onRequestClose={onClose}>
            <View style={st.root}>
                <Pressable
                    style={st.backdrop}
                    onPress={onClose}
                    accessibilityRole='button'
                    accessibilityLabel='Close'
                />
                <Animated.View
                    style={[st.sheet, { maxHeight, transform: [{ translateY }] }]}
                    {...dragResponder.panHandlers}
                >
                    <View style={st.handle} />
                    {header}
                    <ScrollView
                        style={st.scroll}
                        contentContainerStyle={st.scrollContent}
                        showsVerticalScrollIndicator={false}
                        scrollEnabled={canScroll}
                        bounces={false}
                        scrollEventThrottle={16}
                        onScroll={e => { scrollOffsetRef.current = e.nativeEvent.contentOffset.y; }}
                        onLayout={e => {
                            sizesRef.current.viewport = e.nativeEvent.layout.height;
                            updateCanScroll();
                        }}
                        onContentSizeChange={(_, h) => {
                            sizesRef.current.content = h;
                            updateCanScroll();
                        }}
                    >
                        {children}
                    </ScrollView>
                    {footer}
                </Animated.View>
            </View>
        </Modal>
    );
};

// Small round icon button for the card header (copy, share…). `active`
// flips it to a filled state for transient feedback such as "copied".
export const SheetIconButton = ({ icon, label, onPress, active = false }) => {
    const { colors } = useTheme();
    const st = useStyles(makeStyles);
    return (
        <TouchableOpacity
            style={[st.iconBtn, active && st.iconBtnActive]}
            onPress={onPress}
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
            activeOpacity={0.7}
            accessibilityRole='button'
            accessibilityLabel={label}
        >
            <Icon name={icon} size={15} color={active ? colors.bg : colors.accent} />
        </TouchableOpacity>
    );
};

// Hands the English text to an outside assistant through the share sheet.
// Shown large when the built-in translation failed, small as a link otherwise.
export const AskAssistantButton = ({ onPress, compact = false }) => {
    const { colors } = useTheme();
    const st = useStyles(makeStyles);
    return (
        <TouchableOpacity
            style={compact ? st.askLink : st.askBtn}
            onPress={onPress}
            activeOpacity={0.75}
            accessibilityRole='button'
            accessibilityLabel='Ask an assistant about this text'
        >
            <Icon name='message-circle' size={compact ? 13 : 15} color={colors.accent} />
            <Text style={compact ? st.askLinkText : st.askBtnText}>
                {compact ? 'Ask an assistant' : 'Ask ChatGPT, Gemini…'}
            </Text>
        </TouchableOpacity>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    root: { flex: 1, justifyContent: 'flex-end' },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.backdrop },
    sheet: {
        backgroundColor: colors.surface,
        borderTopLeftRadius: radii.xl,
        borderTopRightRadius: radii.xl,
        padding: 24,
        paddingBottom: 0,
        borderTopWidth: 0.5,
        borderTopColor: colors.hairline,
    },
    handle: { width: 36, height: 4, backgroundColor: colors.textMuted, borderRadius: 2, alignSelf: 'center', marginBottom: 20 },
    scroll: { flexShrink: 1 },
    scrollContent: { paddingBottom: 8 },

    iconBtn: {
        width: 30,
        height: 30,
        borderRadius: 15,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.hairlineFaint,
        borderWidth: 0.5,
        borderColor: colors.hairline,
    },
    iconBtnActive: { backgroundColor: colors.accent, borderColor: colors.accent },

    askBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        alignSelf: 'flex-start',
        paddingVertical: 11,
        paddingHorizontal: 16,
        borderRadius: radii.pill,
        backgroundColor: withAlpha(colors.accent, 0.12),
        borderWidth: 0.5,
        borderColor: withAlpha(colors.accent, 0.35),
    },
    askBtnText: { color: colors.accent, fontSize: 14, fontWeight: '700' },
    askLink: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    askLinkText: { color: colors.accent, fontSize: 13, fontWeight: '600' },
});

export default SheetModal;
