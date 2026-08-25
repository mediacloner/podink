import React, { useCallback, useEffect, useRef } from 'react';
import { Animated, PanResponder, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather as Icon } from '@expo/vector-icons';
import { colors } from '../theme';

const ACTION_WIDTH = 80;
const THRESHOLD = 50;

// Module-level coordinator: at most one row is open at a time. List screens
// call closeOpenRow from onScrollBeginDrag so rows also close on scroll.
let _openRowClose = null;

export const closeOpenRow = () => {
    if (_openRowClose) {
        const close = _openRowClose;
        _openRowClose = null;
        close();
    }
};

/**
 * SwipeableRow — shared swipe-to-reveal row.
 *
 * leftAction  (revealed by swiping RIGHT):  { icon, label?, color?, onPress, accessibilityLabel?, dismiss? }
 * rightAction (revealed by swiping LEFT):   same shape.
 *
 * dismiss controls what happens when the action is tapped:
 *   'slide-out' — row slides off-screen, then onPress fires (delete semantics, default for rightAction)
 *   'ack'       — short slide + snap back, onPress fires mid-animation (default for leftAction)
 *   'close'     — row springs shut, then onPress fires (use when onPress shows a confirmation)
 */
const SwipeableRow = ({ children, leftAction, rightAction }) => {
    const translateX = useRef(new Animated.Value(0)).current;
    const openRef = useRef(null); // null | 'left' | 'right' — which action is revealed

    // The PanResponder is created once and freezes its closure; mirror the
    // action props in refs so the handlers always see the latest values.
    const leftRef = useRef(leftAction);
    const rightRef = useRef(rightAction);
    useEffect(() => { leftRef.current = leftAction; }, [leftAction]);
    useEffect(() => { rightRef.current = rightAction; }, [rightAction]);

    const close = useCallback(() => {
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
        openRef.current = null;
        if (_openRowClose === close) _openRowClose = null;
    }, [translateX]);

    const open = useCallback((side) => {
        if (_openRowClose && _openRowClose !== close) _openRowClose();
        _openRowClose = close;
        openRef.current = side;
        Animated.spring(translateX, {
            toValue: side === 'left' ? ACTION_WIDTH : -ACTION_WIDTH,
            useNativeDriver: true,
            bounciness: 4,
        }).start();
    }, [close, translateX]);

    useEffect(() => () => { if (_openRowClose === close) _openRowClose = null; }, [close]);

    const fireAction = useCallback((side) => {
        const action = side === 'left' ? leftRef.current : rightRef.current;
        if (!action) return;
        const dismiss = action.dismiss || (side === 'left' ? 'ack' : 'slide-out');
        openRef.current = null;
        if (_openRowClose === close) _openRowClose = null;

        if (dismiss === 'slide-out') {
            const target = side === 'left' ? 400 : -400;
            Animated.timing(translateX, { toValue: target, duration: 200, useNativeDriver: true })
                .start(async () => {
                    // If onPress resolves false the item wasn't removed (e.g. a
                    // failed delete restores it under the same key) — spring the
                    // row back so it can't sit stuck off-screen showing the
                    // action background with no content.
                    const removed = await action.onPress?.();
                    if (removed === false) {
                        Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
                    }
                });
        } else if (dismiss === 'ack') {
            const target = side === 'left' ? ACTION_WIDTH * 1.5 : -ACTION_WIDTH * 1.5;
            Animated.timing(translateX, { toValue: target, duration: 160, useNativeDriver: true })
                .start(() => {
                    action.onPress?.();
                    Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 0, speed: 18 }).start();
                });
        } else {
            Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 4 })
                .start(() => action.onPress?.());
        }
    }, [close, translateX]);

    const panResponder = useRef(PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) =>
            Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy * 1.5),
        onPanResponderGrant: () => {
            if (_openRowClose && _openRowClose !== close) _openRowClose();
        },
        onPanResponderMove: (_, g) => {
            const base = openRef.current === 'right' ? -ACTION_WIDTH
                : openRef.current === 'left' ? ACTION_WIDTH : 0;
            const next = base + g.dx;
            const min = rightRef.current ? -ACTION_WIDTH : 0;
            const max = leftRef.current ? ACTION_WIDTH : 0;
            translateX.setValue(Math.max(min, Math.min(max, next)));
        },
        onPanResponderRelease: (_, g) => {
            const base = openRef.current === 'right' ? -ACTION_WIDTH
                : openRef.current === 'left' ? ACTION_WIDTH : 0;
            const delta = base + g.dx;
            if (rightRef.current && delta < -THRESHOLD) {
                open('right');
            } else if (leftRef.current && delta > THRESHOLD) {
                open('left');
            } else {
                close();
            }
        },
        onPanResponderTerminate: () => close(),
    })).current;

    const renderAction = (action, side) => (
        <TouchableOpacity
            style={[
                styles.action,
                side === 'left' ? styles.actionLeft : styles.actionRight,
                { backgroundColor: action.color || colors.danger },
            ]}
            onPress={() => fireAction(side)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={action.accessibilityLabel || action.label || 'Row action'}
        >
            <Icon name={action.icon} size={20} color={colors.textPrimary} />
            {!!action.label && <Text style={styles.actionLabel}>{action.label}</Text>}
        </TouchableOpacity>
    );

    return (
        <View style={styles.container}>
            {leftAction && renderAction(leftAction, 'left')}
            {rightAction && renderAction(rightAction, 'right')}
            <Animated.View {...panResponder.panHandlers} style={{ transform: [{ translateX }] }}>
                {children}
            </Animated.View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: { position: 'relative', overflow: 'hidden' },
    action: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        width: ACTION_WIDTH,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
    },
    actionLeft: { left: 0 },
    actionRight: { right: 0 },
    actionLabel: {
        fontSize: 10,
        fontWeight: '700',
        color: colors.textPrimary,
        letterSpacing: 0.2,
    },
});

export default SwipeableRow;
