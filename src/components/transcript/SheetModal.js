import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dimensions, Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
    Easing, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather as Icon } from '@expo/vector-icons';
import { radii, withAlpha, useTheme, useStyles } from '../../theme';

// Swipe-down-to-close thresholds: past this drag distance or fling speed
// (px/s) the sheet dismisses; anything less springs back into place.
const CLOSE_DISTANCE = 120;
const CLOSE_VELOCITY = 800;

// Where the card parks until it has been measured — below any screen edge.
const OFFSCREEN = Dimensions.get('screen').height;
const ENTER = { duration: 280, easing: Easing.out(Easing.cubic) };
const EXIT = { duration: 200, easing: Easing.in(Easing.quad) };
const FADE = { duration: 200 };
const SPRING = { damping: 20, stiffness: 220, mass: 0.8 };

// The Modal window is edge-to-edge, so the footer's own padding has to clear
// the system navigation bar (safe-area inset) AND leave breathing room above
// it — an inset-only margin puts the buttons flush against the bar.
const FOOTER_GAP = 20;

// Bottom sheet shared by the translation and word-lookup cards.
//
//  - The Modal itself doesn't animate (animationType 'none'). RN's 'slide'
//    moves the whole modal window, so the dim backdrop slid up together with
//    the card. Now the backdrop fades in place while the card slides up from
//    its measured height, and the reverse plays on close: the sheet stays
//    mounted, showing the last content it had, until the exit ends (callers
//    clear their text the moment they hide the card).
//  - Dragging is a gesture-handler Pan on the card, declared simultaneous
//    with the body ScrollView's native gesture. It reacts only to drags that
//    begin with the body scrolled to the top, so a long body still scrolls
//    normally; upward drags fail the pan at once so they never fight the
//    scroll. This replaces a JS PanResponder that Android's ScrollView beat
//    to the gesture whenever the content overflowed.
// `scrollRef` (optional) receives the body ScrollView so a caller can scroll
// its content into view (the word card jumps to a phrasal verb's definition).
const SheetModal = ({ visible, onClose, header, footer, children, maxHeight = '85%', scrollRef }) => {
    const st = useStyles(makeStyles);
    const { bottom } = useSafeAreaInsets();
    const [mounted, setMounted] = useState(visible);

    const translateY = useSharedValue(OFFSCREEN);
    const backdrop = useSharedValue(0);
    const sheetHeight = useSharedValue(0);
    const scrollY = useSharedValue(0);
    const dragFromTop = useSharedValue(false);

    const visibleRef = useRef(visible);
    const enteredRef = useRef(false);
    const onCloseRef = useRef(onClose);
    useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

    // Content frozen at the moment of closing, rendered while sliding out.
    const shownRef = useRef({ header, footer, children });
    if (visible) shownRef.current = { header, footer, children };
    const shown = visible ? { header, footer, children } : shownRef.current;

    const requestClose = useCallback(() => { onCloseRef.current?.(); }, []);
    // Reached from the exit animation's completion; a re-open that interrupted
    // the exit has already flipped `visible` back and must keep the sheet.
    const unmount = useCallback(() => { if (!visibleRef.current) setMounted(false); }, []);

    useEffect(() => {
        visibleRef.current = visible;
        if (visible) {
            if (mounted) {
                // Re-opened while still sliding out: come straight back.
                enteredRef.current = true;
                translateY.value = withTiming(0, ENTER);
                backdrop.value = withTiming(1, FADE);
            } else {
                enteredRef.current = false;
                translateY.value = OFFSCREEN;
                backdrop.value = 0;
                scrollY.value = 0;
                setMounted(true);
            }
        } else if (mounted) {
            backdrop.value = withTiming(0, FADE);
            translateY.value = withTiming(sheetHeight.value || OFFSCREEN, EXIT, () => {
                runOnJS(unmount)();
            });
        }
        // Reacts to visibility flips only, reading the mount state at that
        // moment; `mounted` changing on its own must not replay animations.
    }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

    // First layout of an open: start below the edge by exactly the card's
    // height and slide in. Later layouts (content loaded) only refresh the
    // height the exit animation travels.
    const onSheetLayout = useCallback((e) => {
        const h = e.nativeEvent.layout.height;
        sheetHeight.value = h;
        if (enteredRef.current) return;
        enteredRef.current = true;
        translateY.value = h;
        translateY.value = withTiming(0, ENTER);
        backdrop.value = withTiming(1, FADE);
    }, [backdrop, sheetHeight, translateY]);

    const nativeScroll = useMemo(() => Gesture.Native(), []);
    const pan = useMemo(() => Gesture.Pan()
        // Off while closing, so a stray drag can't interrupt the exit.
        .enabled(visible)
        .activeOffsetY(8)
        .failOffsetY(-8)
        .simultaneousWithExternalGesture(nativeScroll)
        .onBegin(() => { dragFromTop.value = scrollY.value <= 0; })
        .onUpdate((e) => {
            if (dragFromTop.value) translateY.value = Math.max(0, e.translationY);
        })
        .onEnd((e) => {
            if (!dragFromTop.value) return;
            if (translateY.value > CLOSE_DISTANCE || e.velocityY > CLOSE_VELOCITY) {
                runOnJS(requestClose)();
            } else {
                translateY.value = withSpring(0, SPRING);
            }
        })
        .onFinalize((_, success) => {
            // Cancelled mid-drag (not a normal release): snap back.
            if (!success && dragFromTop.value && translateY.value > 0) {
                translateY.value = withSpring(0, SPRING);
            }
        }),
    [visible, nativeScroll, dragFromTop, scrollY, translateY, requestClose]);

    const backdropStyle = useAnimatedStyle(() => ({ opacity: backdrop.value }));
    const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: translateY.value }] }));

    return (
        <Modal
            visible={mounted}
            transparent
            animationType='none'
            statusBarTranslucent
            navigationBarTranslucent
            onRequestClose={requestClose}
        >
            {/* A Modal is its own native window, so gesture handlers need
                their own root inside it. Touches are cut while the card
                slides out so nothing can strand it half-closed. */}
            <GestureHandlerRootView style={st.root} pointerEvents={visible ? 'auto' : 'none'}>
                <Animated.View style={[st.backdrop, backdropStyle]}>
                    <Pressable
                        style={StyleSheet.absoluteFill}
                        onPress={requestClose}
                        accessibilityRole='button'
                        accessibilityLabel='Close'
                    />
                </Animated.View>
                <GestureDetector gesture={pan}>
                    <Animated.View style={[st.sheet, { maxHeight }, sheetStyle]} onLayout={onSheetLayout}>
                        <View style={st.handle} />
                        {shown.header}
                        <GestureDetector gesture={nativeScroll}>
                            <ScrollView
                                ref={scrollRef}
                                style={st.scroll}
                                contentContainerStyle={st.scrollContent}
                                showsVerticalScrollIndicator={false}
                                bounces={false}
                                overScrollMode='never'
                                scrollEventThrottle={16}
                                onScroll={(e) => { scrollY.value = e.nativeEvent.contentOffset.y; }}
                            >
                                {shown.children}
                            </ScrollView>
                        </GestureDetector>
                        {shown.footer != null && (
                            <View style={{ paddingBottom: bottom + FOOTER_GAP }}>{shown.footer}</View>
                        )}
                    </Animated.View>
                </GestureDetector>
            </GestureHandlerRootView>
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
