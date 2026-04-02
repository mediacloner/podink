/**
 * AppAlert — a custom in-app alert that matches the app's dark design.
 *
 * Usage (imperative, works from anywhere including services):
 *
 *   import { showAlert } from '../components/AppAlert';
 *
 *   // Simple message
 *   showAlert('Title', 'Something happened.');
 *
 *   // With buttons (same shape as React Native's Alert.alert)
 *   showAlert('Delete?', 'This cannot be undone.', [
 *     { text: 'Cancel',  style: 'cancel' },
 *     { text: 'Delete',  style: 'destructive', onPress: () => doDelete() },
 *   ]);
 *
 * Register the component once at the root (App.js):
 *
 *   import AppAlert, { setAlertRef } from './components/AppAlert';
 *   const alertRef = useRef();
 *   useEffect(() => setAlertRef(alertRef.current), []);
 *   // In JSX (inside SafeAreaProvider, outside NavigationContainer):
 *   <AppAlert ref={alertRef} />
 */

import React, {
    forwardRef,
    useCallback,
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

/** Called once from App.js after the component mounts. */
export const setAlertRef = (ref) => { _ref = ref; };

/**
 * Show a themed in-app alert. Drop-in replacement for Alert.alert.
 * @param {string}   title
 * @param {string}   [message]
 * @param {Array}    [buttons]  — [{ text, style?, onPress? }]  (same as RN Alert)
 */
export const showAlert = (title, message, buttons) => {
    if (_ref) {
        _ref.show(title, message ?? '', buttons ?? [{ text: 'OK' }]);
    }
};

// ─── Component ────────────────────────────────────────────────────────────────

const { width: SCREEN_W } = Dimensions.get('window');
const CARD_WIDTH = Math.min(320, SCREEN_W - 56);

const AppAlert = forwardRef((_props, ref) => {
    const [visible, setVisible]   = useState(false);
    const [title,   setTitle]     = useState('');
    const [message, setMessage]   = useState('');
    const [buttons, setButtons]   = useState([{ text: 'OK' }]);

    const backdropAnim = useRef(new Animated.Value(0)).current;
    const scaleAnim    = useRef(new Animated.Value(0.88)).current;
    const opacityAnim  = useRef(new Animated.Value(0)).current;

    const _animateIn = useCallback(() => {
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
    }, [backdropAnim, scaleAnim, opacityAnim]);

    const _animateOut = useCallback((cb) => {
        Animated.parallel([
            Animated.timing(backdropAnim, {
                toValue: 0, duration: 160, useNativeDriver: true,
            }),
            Animated.timing(opacityAnim, {
                toValue: 0, duration: 140, useNativeDriver: true,
            }),
            Animated.timing(scaleAnim, {
                toValue: 0.92, duration: 140, useNativeDriver: true,
            }),
        ]).start(() => { setVisible(false); cb?.(); });
    }, [backdropAnim, opacityAnim, scaleAnim]);

    useImperativeHandle(ref, () => ({
        show(t, m, btns) {
            setTitle(t);
            setMessage(m ?? '');
            setButtons(btns?.length ? btns : [{ text: 'OK' }]);
            // Reset animation values before showing
            backdropAnim.setValue(0);
            scaleAnim.setValue(0.88);
            opacityAnim.setValue(0);
            setVisible(true);
            // Animate after state flush
            requestAnimationFrame(_animateIn);
        },
    }), [_animateIn, backdropAnim, scaleAnim, opacityAnim]);

    const handlePress = useCallback((btn) => {
        _animateOut(() => btn.onPress?.());
    }, [_animateOut]);

    // Determine button layout: ≤2 side by side, 3+ stacked
    const horizontal = buttons.length <= 2;

    if (!visible) return null;

    return (
        <Modal
            transparent
            visible={visible}
            animationType="none"
            statusBarTranslucent
            onRequestClose={() => {
                const cancel = buttons.find(b => b.style === 'cancel');
                handlePress(cancel ?? { text: 'OK' });
            }}
        >
            {/* Backdrop */}
            <Animated.View style={[s.backdrop, { opacity: backdropAnim }]}>
                <Pressable style={StyleSheet.absoluteFill} onPress={() => {
                    const cancel = buttons.find(b => b.style === 'cancel');
                    if (cancel) handlePress(cancel);
                }} />
            </Animated.View>

            {/* Card */}
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

                    {/* Divider */}
                    <View style={s.dividerH} />

                    {/* Buttons */}
                    <View style={[s.btnRow, !horizontal && s.btnCol]}>
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
                                        onPress={() => handlePress(btn)}
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
        flex: 1,
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
        // Subtle shadow lift
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.55,
        shadowRadius: 24,
        elevation: 16,
    },

    // Text block
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

    // Dividers
    dividerH: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: 'rgba(255,255,255,0.08)',
    },
    dividerV: {
        width: StyleSheet.hairlineWidth,
        backgroundColor: 'rgba(255,255,255,0.08)',
    },

    // Button row/col
    btnRow: { flexDirection: 'row' },
    btnCol: { flexDirection: 'column' },
    btnFlex: { flex: 1 },

    btn: {
        paddingVertical: 16,
        alignItems: 'center',
        justifyContent: 'center',
    },
    btnText: {
        fontSize: 15,
        fontWeight: '600',
    },
    btnDefault:     { color: '#4FACFE' },
    btnCancel:      { color: '#AEAEB2', fontWeight: '400' },
    btnDestructive: { color: '#FF453A' },
});
