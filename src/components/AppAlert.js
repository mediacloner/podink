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

// ─── Imperative bridge ────────────────────────────────────────────────────────
// The component registers _show when it mounts and clears it on unmount.
// No external ref wiring needed — avoids the timing issues with
// forwardRef + useImperativeHandle + parent useEffect on Android.

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
    const [visible,  setVisible]  = useState(false);
    const [title,    setTitle]    = useState('');
    const [message,  setMessage]  = useState('');
    const [buttons,  setButtons]  = useState([{ text: 'OK' }]);

    const backdropAnim = useRef(new Animated.Value(0)).current;
    const scaleAnim    = useRef(new Animated.Value(0.88)).current;
    const opacityAnim  = useRef(new Animated.Value(0)).current;

    // Self-register when mounted so showAlert() works from anywhere
    useEffect(() => {
        _show = (t, m, btns) => {
            setTitle(t);
            setMessage(m);
            setButtons(btns);
            setVisible(true);
        };
        return () => { _show = null; };
    }, []);

    // Animate in after React commits the Modal (useEffect fires post-commit)
    useEffect(() => {
        if (!visible) return;
        backdropAnim.setValue(0);
        scaleAnim.setValue(0.88);
        opacityAnim.setValue(0);
        Animated.parallel([
            Animated.timing(backdropAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
            Animated.spring(scaleAnim,    { toValue: 1, damping: 20, stiffness: 280, useNativeDriver: true }),
            Animated.timing(opacityAnim,  { toValue: 1, duration: 160, useNativeDriver: true }),
        ]).start();
    }, [visible, backdropAnim, scaleAnim, opacityAnim]);

    const dismiss = useCallback((btn) => {
        Animated.parallel([
            Animated.timing(backdropAnim, { toValue: 0, duration: 160, useNativeDriver: true }),
            Animated.timing(opacityAnim,  { toValue: 0, duration: 130, useNativeDriver: true }),
            Animated.timing(scaleAnim,    { toValue: 0.92, duration: 140, useNativeDriver: true }),
        ]).start(() => {
            setVisible(false);
            btn?.onPress?.();
        });
    }, [backdropAnim, opacityAnim, scaleAnim]);

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
    title:   { fontSize: 17, fontWeight: '700', color: '#FFFFFF', textAlign: 'center', letterSpacing: -0.2 },
    message: { fontSize: 14, color: '#AEAEB2', textAlign: 'center', lineHeight: 20 },

    dividerH: { height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.08)' },
    dividerV: { width:  StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.08)' },

    btnRow:  { flexDirection: 'row' },
    btnCol:  { flexDirection: 'column' },
    btnFlex: { flex: 1 },
    btn:     { paddingVertical: 16, alignItems: 'center', justifyContent: 'center' },
    btnText: { fontSize: 15, fontWeight: '600' },

    btnDefault:     { color: '#4FACFE' },
    btnCancel:      { color: '#AEAEB2', fontWeight: '400' },
    btnDestructive: { color: '#FF453A' },
});
