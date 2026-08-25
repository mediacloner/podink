/**
 * AppAlert — custom in-app alert that matches the app's dark design.
 *
 * Usage (callable from anywhere, no setup required in the caller):
 *
 *   import { showAlert } from '../components/AppAlert';
 *
 *   showAlert('Title', 'Message');
 *   showAlert('Delete?', 'Cannot be undone.', [
 *     { text: 'Cancel',  style: 'cancel' },
 *     { text: 'Delete',  style: 'destructive', onPress: () => doIt() },
 *   ]);
 *
 * Alerts fired while one is visible are queued (not overwritten mid-animation)
 * and presented in order as each one is dismissed.
 *
 * Mount once at the root (App.js), no ref or extra wiring needed:
 *
 *   import AppAlert from './components/AppAlert';
 *   // inside JSX:
 *   <AppAlert />
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import { colors, radii } from '../theme';

// ─── Imperative bridge ────────────────────────────────────────────────────────
// The component registers _show when it mounts and clears it on unmount.

let _show = null;

export const showAlert = (title, message, buttons) => {
    if (_show) {
        _show(title ?? '', message ?? '', buttons?.length ? buttons : [{ text: 'OK' }]);
    }
};

// ─── Component ────────────────────────────────────────────────────────────────

const { width: SCREEN_W } = Dimensions.get('window');
const CARD_WIDTH = Math.min(320, SCREEN_W - 56);

const AppAlert = () => {
    const [visible, setVisible] = useState(false);
    const [title, setTitle] = useState('');
    const [message, setMessage] = useState('');
    const [buttons, setButtons] = useState([{ text: 'OK' }]);

    const backdropAnim = useRef(new Animated.Value(0)).current;
    const scaleAnim = useRef(new Animated.Value(0.88)).current;
    const opacityAnim = useRef(new Animated.Value(0)).current;

    // Alerts requested while one is on screen wait here instead of replacing
    // the visible card mid-animation.
    const queueRef = useRef([]);
    const visibleRef = useRef(false);
    const currentRef = useRef(null);

    const present = useCallback((alert) => {
        currentRef.current = alert;
        visibleRef.current = true;
        setTitle(alert.title);
        setMessage(alert.message);
        setButtons(alert.buttons);
        setVisible(true);
        // Own the entrance animation here instead of an effect keyed on
        // `visible`. When a queued alert is presented in dismiss()'s completion
        // callback, React 18+ batches setVisible(false)+setVisible(true) into a
        // true->true no-op, so a [visible]-gated effect would never re-run and
        // the next alert would render fully transparent inside a touch-blocking
        // Modal. requestAnimationFrame defers to a frame boundary so the reset
        // values apply before the codegen animation starts.
        requestAnimationFrame(() => {
            backdropAnim.setValue(0);
            scaleAnim.setValue(0.88);
            opacityAnim.setValue(0);
            Animated.parallel([
                Animated.timing(backdropAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
                Animated.spring(scaleAnim, { toValue: 1, damping: 20, stiffness: 280, useNativeDriver: true }),
                Animated.timing(opacityAnim, { toValue: 1, duration: 160, useNativeDriver: true }),
            ]).start();
        });
    }, [backdropAnim, scaleAnim, opacityAnim]);

    // Self-register when mounted so showAlert() works from anywhere
    useEffect(() => {
        _show = (t, m, btns) => {
            const alert = { title: t, message: m, buttons: btns };
            if (visibleRef.current) {
                const cur = currentRef.current;
                const last = queueRef.current[queueRef.current.length - 1];
                const sameAs = (a) => a && a.title === t && a.message === m;
                // Drop exact duplicates (e.g. several feeds failing identically)
                if (sameAs(cur) || sameAs(last)) return;
                queueRef.current.push(alert);
                return;
            }
            present(alert);
        };
        return () => { _show = null; };
    }, [present]);

    // (Entrance animation now lives in present() — see comment there. It must
    // run for every presented alert regardless of any batched true->true
    // `visible` transition when draining the queue.)

    const dismiss = useCallback((btn) => {
        Animated.parallel([
            Animated.timing(backdropAnim, { toValue: 0, duration: 160, useNativeDriver: true }),
            Animated.timing(opacityAnim, { toValue: 0, duration: 130, useNativeDriver: true }),
            Animated.timing(scaleAnim, { toValue: 0.92, duration: 140, useNativeDriver: true }),
        ]).start(() => {
            setVisible(false);
            visibleRef.current = false;
            currentRef.current = null;
            btn?.onPress?.();
            // onPress may itself have shown an alert; only drain if it didn't.
            if (!visibleRef.current && queueRef.current.length > 0) {
                present(queueRef.current.shift());
            }
        });
    }, [backdropAnim, opacityAnim, scaleAnim, present]);

    const handleBackdropPress = useCallback(() => {
        const cancel = buttons.find(b => b.style === 'cancel');
        if (cancel) dismiss(cancel);
    }, [buttons, dismiss]);

    const horizontal = buttons.length <= 2;

    return (
        <Modal
            transparent
            visible={visible}
            animationType="none"
            statusBarTranslucent
            onRequestClose={handleBackdropPress}
        >
            <Animated.View style={[s.backdrop, { opacity: backdropAnim }]} />
            <Pressable style={StyleSheet.absoluteFill} onPress={handleBackdropPress} />

            <View style={s.centerer} pointerEvents="box-none">
                <Animated.View style={[
                    s.card,
                    { opacity: opacityAnim, transform: [{ scale: scaleAnim }] },
                ]}>
                    <View style={s.textBlock}>
                        <Text style={s.title}>{title}</Text>
                        {!!message && <Text style={s.message}>{message}</Text>}
                    </View>

                    <View style={s.dividerH} />

                    <View style={horizontal ? s.btnRow : s.btnCol}>
                        {buttons.map((btn, idx) => {
                            const isDestructive = btn.style === 'destructive';
                            const isCancel = btn.style === 'cancel';
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
                                        accessibilityRole="button"
                                        accessibilityLabel={btn.text}
                                    >
                                        <Text style={[
                                            s.btnText,
                                            isDestructive && s.btnDestructive,
                                            isCancel && s.btnCancel,
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
};

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
        backgroundColor: colors.surfaceElevated,
        borderRadius: radii.l,
        borderWidth: 0.5,
        borderColor: colors.hairline,
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
    title: { fontSize: 17, fontWeight: '700', color: colors.textPrimary, textAlign: 'center', letterSpacing: -0.2 },
    message: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 20 },

    dividerH: { height: StyleSheet.hairlineWidth, backgroundColor: colors.hairline },
    dividerV: { width: StyleSheet.hairlineWidth, backgroundColor: colors.hairline },

    btnRow: { flexDirection: 'row' },
    btnCol: { flexDirection: 'column' },
    btnFlex: { flex: 1 },
    btn: { paddingVertical: 16, alignItems: 'center', justifyContent: 'center' },
    btnText: { fontSize: 15, fontWeight: '600' },

    btnDefault: { color: colors.accent },
    btnCancel: { color: colors.textSecondary, fontWeight: '400' },
    btnDestructive: { color: colors.danger },
});
