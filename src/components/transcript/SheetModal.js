import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dimensions, Keyboard, Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
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
// Pull-up thresholds (sheets with `onPullUp`): an upward drag this far, or an
// upward fling this fast, while the body sits at its top.
const PULL_UP_DISTANCE = 48;
const PULL_UP_VELOCITY = 600;

// Where the card parks until it has been measured — below any screen edge.
const OFFSCREEN = Dimensions.get('screen').height;
const ENTER = { duration: 280, easing: Easing.out(Easing.cubic) };
const EXIT = { duration: 200, easing: Easing.in(Easing.quad) };
const FADE = { duration: 200 };
const SPRING = { damping: 20, stiffness: 220, mass: 0.8 };

// The Modal window is edge-to-edge, so the footer's own padding has to clear
// the system navigation bar (safe-area inset) AND leave breathing room above
// it — an inset-only margin puts the buttons flush against the bar. A card
// with no footer gives that same clearance to its scrolling body instead,
// which is the card's last element then (the chapter sheet's button sat
// behind the navigation buttons until it did).
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
//  - `onPullUp` (optional) makes the sheet answer an upward drag as well: a
//    pull past PULL_UP_DISTANCE, or an upward fling, with the body still at
//    its top calls it once per gesture (the translation card unfolds the
//    lines before the sentence — user, 2026-09-22: "if I move the popover
//    up you show the context"). A body that scrolls under the finger is a
//    scroll, not a pull: the check reads the scroll offset as it goes.
// `scrollRef` (optional) receives the body ScrollView so a caller can scroll
// its content into view (the word card jumps to a phrasal verb's definition).
const SheetModal = ({ visible, onClose, header, footer, children, maxHeight = '85%', scrollRef, onPullUp }) => {
    const st = useStyles(makeStyles);
    const { bottom, top } = useSafeAreaInsets();
    const [mounted, setMounted] = useState(visible);

    // Keyboard (the note typed in the sentence card): the Modal's window is
    // edge-to-edge on Android, where adjustResize no longer shrinks it, so
    // the sheet lifts itself over the keyboard. What it lifts by is the
    // keyboard's TOP EDGE (screenY) measured down from the card's own full
    // height, not the height RN reports: that height is the IME window's
    // own, which stops at the navigation bar — 24 dp short of the
    // edge-to-edge Modal's bottom on a Pixel — and the Close button was
    // landing in exactly that gap (user, 2026-09-12: "I can't see the
    // button of close"). The reported height stays the floor, for anything
    // that gives no usable screenY. The lift is measured against the root's
    // own layout — where the window did shrink (iOS, older Android) the
    // shrink is subtracted, so the sheet never lifts twice — and the card is
    // capped to the space left above the keyboard.
    const [kb, setKb] = useState({ height: 0, top: 0 });
    const [rootHeight, setRootHeight] = useState(0);
    const fullHeightRef = useRef(0);
    useEffect(() => {
        const onShow = (e) => {
            const c = e?.endCoordinates;
            if (!c?.height) return;   // a frame change with no keyboard is a hide; didHide clears it
            setKb({ height: c.height, top: c.screenY ?? 0 });
        };
        const show = Keyboard.addListener('keyboardDidShow', onShow);
        const change = Keyboard.addListener('keyboardDidChangeFrame', onShow);
        const hide = Keyboard.addListener('keyboardDidHide', () => setKb({ height: 0, top: 0 }));
        return () => { show.remove(); change.remove(); hide.remove(); };
    }, []);
    const onRootLayout = useCallback((e) => {
        const h = e.nativeEvent.layout.height;
        if (!kb.height) fullHeightRef.current = Math.max(fullHeightRef.current, h);
        setRootHeight(h);
    }, [kb.height]);
    const shrink = Math.max(0, fullHeightRef.current - rootHeight);
    const covered = kb.height ? Math.max(kb.height, fullHeightRef.current - kb.top) : 0;
    const lift = Math.max(0, covered - shrink);
    const liftedMaxHeight = lift ? Math.max(240, rootHeight - lift - top - 12) : maxHeight;

    const translateY = useSharedValue(OFFSCREEN);
    const backdrop = useSharedValue(0);
    const sheetHeight = useSharedValue(0);
    const scrollY = useSharedValue(0);
    const dragFromTop = useSharedValue(false);
    const pulledUp = useSharedValue(false);

    const visibleRef = useRef(visible);
    const enteredRef = useRef(false);
    const onCloseRef = useRef(onClose);
    useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
    const onPullUpRef = useRef(onPullUp);
    useEffect(() => { onPullUpRef.current = onPullUp; }, [onPullUp]);
    const hasPullUp = !!onPullUp;

    // Content frozen at the moment of closing, rendered while sliding out.
    const shownRef = useRef({ header, footer, children });
    if (visible) shownRef.current = { header, footer, children };
    const shown = visible ? { header, footer, children } : shownRef.current;

    const requestClose = useCallback(() => { onCloseRef.current?.(); }, []);
    const requestPullUp = useCallback(() => { onPullUpRef.current?.(); }, []);
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
            Keyboard.dismiss();
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
    const pan = useMemo(() => {
        // Off while closing, so a stray drag can't interrupt the exit.
        const base = Gesture.Pan().enabled(visible).simultaneousWithExternalGesture(nativeScroll);
        // Without a pull-up handler an upward drag fails the pan at once, so
        // it never fights the body's scroll; with one it stays alive upward
        // too and the scroll offset tells a pull from a scroll.
        const g = hasPullUp ? base.activeOffsetY([-8, 8]) : base.activeOffsetY(8).failOffsetY(-8);
        return g
            .onBegin(() => { dragFromTop.value = scrollY.value <= 0; pulledUp.value = false; })
            .onUpdate((e) => {
                if (!dragFromTop.value) return;
                if (e.translationY >= 0) {
                    translateY.value = e.translationY;
                } else if (hasPullUp && !pulledUp.value && scrollY.value <= 0 && e.translationY < -PULL_UP_DISTANCE) {
                    pulledUp.value = true;
                    runOnJS(requestPullUp)();
                }
            })
            .onEnd((e) => {
                if (!dragFromTop.value) return;
                if (translateY.value > CLOSE_DISTANCE || e.velocityY > CLOSE_VELOCITY) {
                    runOnJS(requestClose)();
                } else {
                    if (hasPullUp && !pulledUp.value && scrollY.value <= 0 && e.velocityY < -PULL_UP_VELOCITY) {
                        pulledUp.value = true;
                        runOnJS(requestPullUp)();
                    }
                    translateY.value = withSpring(0, SPRING);
                }
            })
            .onFinalize((_, success) => {
                // Cancelled mid-drag (not a normal release): snap back.
                if (!success && dragFromTop.value && translateY.value > 0) {
                    translateY.value = withSpring(0, SPRING);
                }
            });
    }, [visible, hasPullUp, nativeScroll, dragFromTop, pulledUp, scrollY, translateY, requestClose, requestPullUp]);

    // Bottom clearance belongs to whichever is last: the footer when there is
    // one, otherwise the body. Lifted over the keyboard there is no bar to
    // clear (the lift already sits above it).
    const edgeGap = (lift ? 0 : bottom) + FOOTER_GAP;
    const bodyPad = shown.footer != null ? 0 : edgeGap;

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
            <GestureHandlerRootView
                style={[st.root, lift > 0 && { paddingBottom: lift }]}
                pointerEvents={visible ? 'auto' : 'none'}
                onLayout={onRootLayout}
            >
                <Animated.View style={[st.backdrop, backdropStyle]}>
                    <Pressable
                        style={StyleSheet.absoluteFill}
                        onPress={requestClose}
                        accessibilityRole='button'
                        accessibilityLabel='Close'
                    />
                </Animated.View>
                <GestureDetector gesture={pan}>
                    <Animated.View style={[st.sheet, { maxHeight: liftedMaxHeight }, sheetStyle]} onLayout={onSheetLayout}>
                        <View style={st.handle} />
                        {shown.header}
                        <GestureDetector gesture={nativeScroll}>
                            <ScrollView
                                ref={scrollRef}
                                style={st.scroll}
                                contentContainerStyle={[st.scrollContent, bodyPad > 0 && { paddingBottom: bodyPad }]}
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
                            <View style={{ paddingBottom: edgeGap }}>{shown.footer}</View>
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
