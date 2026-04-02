/**
 * AppAlert — custom in-app alert that matches the app's dark design.
 *
 * Usage (imperative, callable from anywhere):
 *
 *   import { showAlert } from '../components/AppAlert';
 *
 *   showAlert('Title', 'Message');
 *   showAlert('Delete?', 'Cannot be undone.', [
 *     { text: 'Cancel',  style: 'cancel' },
 *     { text: 'Delete',  style: 'destructive', onPress: () => doIt() },
 *   ]);
 *
 * Register once in App.js (inside SafeAreaProvider):
 *
 *   import AppAlert, { setAlertRef } from './components/AppAlert';
 *   const alertRef = useRef();
 *   useEffect(() => setAlertRef(alertRef.current), []);
 *   <AppAlert ref={alertRef} />
 */

import React, {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useRef,
    useState,
} from 'react';
import {
    Animated,
    Dimensions,
    Modal,
    Pressable,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';

// ─── Imperative bridge ────────────────────────────────────────────────────────

let _ref = null;

export const setAlertRef = (ref) => { _ref = ref; };

export const showAlert = (title, message, buttons) => {
    if (_ref) {
        _ref.show(title, message ?? '', buttons ?? [{ text: 'OK' }]);
    }
};

// ─── Component ────────────────────────────────────────────────────────────────

const { width: SCREEN_W } = Dimensions.get('window');
const CARD_WIDTH = Math.min(320, SCREEN_W - 56);

const AppAlert = forwardRef((_props, ref) => {
    const [visible,  setVisible]  = useState(false);
    const [title,    setTitle]    = useState('');
    const [message,  setMessage]  = useState('');
    const [buttons,  setButtons]  = useState([{ text: 'OK' }]);

    const backdropAnim = useRef(new Animated.Value(0)).current;
    const scaleAnim    = useRef(new Animated.Value(0.88)).current;
    const opacityAnim  = useRef(new Animated.Value(0)).current;

    // ── Animate in after React commits the Modal to the native layer ──────────
    // useEffect is guaranteed to fire after commit, so the native view exists
    // and the native-driver animations have views to connect to.
    useEffect(() => {
        if (!visible) return;

        // Reset to starting values synchronously so the card begins invisible
        backdropAnim.setValue(0);
        scaleAnim.setValue(0.88);
        opacityAnim.setValue(0);

        Animated.parallel([
            Animated.timing(backdropAnim, {
                toValue: 1, duration: 200, useNativeDriver: true,
            }),
            Animated.spring(scaleAnim, {
                toValue: 1, damping: 20, stiffness: 280, useNativeDriver: true,
            }),
            Animated.timing(opacityAnim, {
                toValue: 1, duration: 160, useNativeDriver: true,
            }),
        ]).start();
    }, [visible, backdropAnim, scaleAnim, opacityAnim]);

    const dismiss = useCallback((btn) => {
        Animated.parallel([
            Animated.timing(backdropAnim, {
                toValue: 0, duration: 160, useNativeDriver: true,
            }),
            Animated.timing(opacityAnim, {
                toValue: 0, duration: 130, useNativeDriver: true,
            }),
            Animated.timing(scaleAnim, {
                toValue: 0.92, duration: 140, useNativeDriver: true,
            }),
        ]).start(() => {
            setVisible(false);
            btn?.onPress?.();
        });
    }, [backdropAnim, opacityAnim, scaleAnim]);

    useImperativeHandle(ref, () => ({
        show(t, m, btns) {
            setTitle(t ?? '');
            setMessage(m ?? '');
            setButtons(btns?.length ? btns : [{ text: 'OK' }]);
            setVisible(true);
            // Animations are triggered by the useEffect above that watches `visible`
        },
    }));

    const handleBackdropPress = useCallback(() => {
        const cancel = buttons.find(b => b.style === 'cancel');
        if (cancel) dismiss(cancel);
    }, [buttons, dismiss]);

    const horizontal = buttons.length <= 2;

    // The Modal is always mounted — only its visibility is toggled.
    // This is critical on Android: mounting a Modal with visible=true for the
    // first time can be unreliable; keeping it mounted avoids the issue.
    return (
        <Modal
            transparent
            visible={visible}
            animationType="none"
            statusBarTranslucent
            onRequestClose={handleBackdropPress}
        >
            {/* Dimmed backdrop */}
            <Animated.View style={[s.backdrop, { opacity: backdropAnim }]} />
            <Pressable style={StyleSheet.absoluteFill} onPress={handleBackdropPress} />

            {/* Card — centred via absolute positioning so Pressable above covers edges */}
            <View style={s.centerer} pointerEvents="box-none">
                <Animated.View style={[
                    s.card,
                    { opacity: opacityAnim, transform: [{ scale: scaleAnim }] },
                ]}>
                    {/* Text */}
                    <View style={s.textBlock}>
                        <Text style={s.title}>{title}</Text>
                        {!!message && <Text style={s.message}>{message}</Text>}
                    </View>

                    <View style={s.dividerH} />

                    {/* Buttons */}
                    <View style={horizontal ? s.btnRow : s.btnCol}>
                        {buttons.map((btn, idx) => {
                            const isDestructive = btn.style === 'destructive';
                            const isCancel      = btn.style === 'cancel';
                            return (
                                <React.Fragment key={idx}>
                                    {idx > 0 && (
                                        horizontal
                                            ? <View style={s.dividerV} />
                                            : <View style={s.dividerH} />
                                    )}
                                    <TouchableOpacity
                                        style={[s.btn, horizontal && s.btnFlex]}
                                        onPress={() => dismiss(btn)}
                                        activeOpacity={0.5}
                                    >
                                        <Text style={[
                                            s.btnText,
                                            isDestructive && s.btnDestructive,
                                            isCancel      && s.btnCancel,
                                            !isDestructive && !isCancel && s.btnDefault,
                                        ]}>
                                            {btn.text}
                                        </Text>
                                    </TouchableOpacity>
                                </React.Fragment>
                            );
                        })}
                    </View>
                </Animated.View>
            </View>
        </Modal>
    );
});

export default AppAlert;

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
    backdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0,0,0,0.65)',
    },
    centerer: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
    },
    card: {
        width: CARD_WIDTH,
        backgroundColor: '#1C1C1E',
        borderRadius: 18,
        borderWidth: 0.5,
        borderColor: 'rgba(255,255,255,0.09)',
        overflow: 'hidden',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.55,
        shadowRadius: 24,
        elevation: 16,
    },

    textBlock: {
        paddingHorizontal: 24,
        paddingTop: 24,
        paddingBottom: 20,
        alignItems: 'center',
        gap: 8,
    },
    title: {
        fontSize: 17,
        fontWeight: '700',
        color: '#FFFFFF',
        textAlign: 'center',
        letterSpacing: -0.2,
    },
    message: {
        fontSize: 14,
        color: '#AEAEB2',
        textAlign: 'center',
        lineHeight: 20,
    },

    dividerH: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: 'rgba(255,255,255,0.08)',
    },
    dividerV: {
        width: StyleSheet.hairlineWidth,
        backgroundColor: 'rgba(255,255,255,0.08)',
    },

    btnRow: { flexDirection: 'row' },
    btnCol: { flexDirection: 'column' },
    btnFlex: { flex: 1 },
    btn: {
        paddingVertical: 16,
        alignItems: 'center',
        justifyContent: 'center',
    },
    btnText:        { fontSize: 15, fontWeight: '600' },
    btnDefault:     { color: '#4FACFE' },
    btnCancel:      { color: '#AEAEB2', fontWeight: '400' },
    btnDestructive: { color: '#FF453A' },
});
