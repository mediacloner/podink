import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Dimensions, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather as Icon } from '@expo/vector-icons';

// Full-screen picture viewer for the word card's Wikipedia thumbnail.
//
//  - Pinch to zoom (1× – 5×), drag while zoomed, double-tap to jump between
//    fit and 2.5×; a single tap on an unzoomed picture closes, as do the X
//    and the Back key.
//  - `thumbUri` (the small image already on screen) shows at once, blurred by
//    its size, while `uri` (the large version) loads over it — and stays if
//    the large one fails, so the viewer never goes blank.
//  - A lightbox is black in both palettes — a photo reads wrong on paper —
//    so this is the one place with fixed colours.
//
// `image` is null (hidden) or { uri, thumbUri, width, height, caption, headers }.

const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const SNAP = { duration: 180 };

const clamp = (v, lo, hi) => {
    'worklet';
    return Math.min(hi, Math.max(lo, v));
};

const ImageViewer = ({ image, onClose }) => {
    const insets = useSafeAreaInsets();
    const [status, setStatus] = useState('loading'); // loading | loaded | failed
    const visible = !!image;

    // The picture fitted inside the window, from its declared size (falling
    // back to a square when the summary gave none).
    const window = Dimensions.get('window');
    const fit = useMemo(() => {
        const w = image?.width || 1;
        const h = image?.height || 1;
        const maxW = window.width;
        const maxH = window.height - insets.top - insets.bottom - 120;
        const k = Math.min(maxW / w, maxH / h);
        return { width: Math.round(w * k), height: Math.round(h * k) };
    }, [image, window.width, window.height, insets.top, insets.bottom]);

    const scale = useSharedValue(1);
    const savedScale = useSharedValue(1);
    const tx = useSharedValue(0);
    const ty = useSharedValue(0);
    const savedTx = useSharedValue(0);
    const savedTy = useSharedValue(0);

    useEffect(() => {
        if (!visible) return;
        setStatus('loading');
        scale.value = 1; savedScale.value = 1;
        tx.value = 0; ty.value = 0; savedTx.value = 0; savedTy.value = 0;
    }, [visible, image, scale, savedScale, tx, ty, savedTx, savedTy]);

    const requestClose = useCallback(() => { onClose?.(); }, [onClose]);

    const gesture = useMemo(() => {
        // Keeps a zoomed picture's edges from drifting inside the window.
        const bound = (s) => {
            'worklet';
            return {
                x: Math.max(0, (fit.width * s - window.width) / 2),
                y: Math.max(0, (fit.height * s - window.height) / 2),
            };
        };
        const reset = () => {
            'worklet';
            scale.value = withTiming(1, SNAP); savedScale.value = 1;
            tx.value = withTiming(0, SNAP); ty.value = withTiming(0, SNAP);
            savedTx.value = 0; savedTy.value = 0;
        };
        const pinch = Gesture.Pinch()
            .onUpdate((e) => { scale.value = clamp(savedScale.value * e.scale, 1, MAX_SCALE); })
            .onEnd(() => {
                if (scale.value <= 1.02) { reset(); return; }
                savedScale.value = scale.value;
                const b = bound(scale.value);
                tx.value = withTiming(clamp(tx.value, -b.x, b.x), SNAP);
                ty.value = withTiming(clamp(ty.value, -b.y, b.y), SNAP);
                savedTx.value = clamp(tx.value, -b.x, b.x);
                savedTy.value = clamp(ty.value, -b.y, b.y);
            });
        const pan = Gesture.Pan()
            .maxPointers(1)
            .onUpdate((e) => {
                if (scale.value <= 1) return;
                const b = bound(scale.value);
                tx.value = clamp(savedTx.value + e.translationX, -b.x, b.x);
                ty.value = clamp(savedTy.value + e.translationY, -b.y, b.y);
            })
            .onEnd(() => { savedTx.value = tx.value; savedTy.value = ty.value; });
        const doubleTap = Gesture.Tap()
            .numberOfTaps(2)
            .onEnd((_e, success) => {
                if (!success) return;
                if (scale.value > 1) { reset(); return; }
                scale.value = withTiming(DOUBLE_TAP_SCALE, SNAP);
                savedScale.value = DOUBLE_TAP_SCALE;
            });
        const singleTap = Gesture.Tap()
            .numberOfTaps(1)
            .onEnd((_e, success) => {
                if (success && scale.value <= 1) runOnJS(requestClose)();
            });
        return Gesture.Simultaneous(pinch, pan, Gesture.Exclusive(doubleTap, singleTap));
    }, [fit, window.width, window.height, scale, savedScale, tx, ty, savedTx, savedTy, requestClose]);

    const imageStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
    }));

    if (!image) return null;
    const source = { uri: image.uri, headers: image.headers };
    const thumb = image.thumbUri ? { uri: image.thumbUri, headers: image.headers } : null;

    return (
        <Modal visible={visible} transparent animationType='fade' statusBarTranslucent navigationBarTranslucent onRequestClose={requestClose}>
            <GestureHandlerRootView style={st.root}>
                <GestureDetector gesture={gesture}>
                    <Animated.View style={[st.stage, { width: fit.width, height: fit.height }, imageStyle]}>
                        {!!thumb && status !== 'loaded' && (
                            <Animated.Image
                                source={thumb}
                                style={StyleSheet.absoluteFill}
                                resizeMode='contain'
                                blurRadius={status === 'loading' ? 1 : 0}
                            />
                        )}
                        {status !== 'failed' && (
                            <Animated.Image
                                source={source}
                                style={StyleSheet.absoluteFill}
                                resizeMode='contain'
                                onLoad={() => setStatus('loaded')}
                                onError={() => setStatus('failed')}
                                accessibilityIgnoresInvertColors
                                accessible
                                accessibilityLabel={image.caption || 'Image'}
                            />
                        )}
                        {status === 'loading' && <ActivityIndicator color='#fff' style={st.spinner} />}
                    </Animated.View>
                </GestureDetector>

                <TouchableOpacity
                    style={[st.closeBtn, { top: insets.top + 12 }]}
                    onPress={requestClose}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    activeOpacity={0.7}
                    accessibilityRole='button'
                    accessibilityLabel='Close image'
                >
                    <Icon name='x' size={22} color='#fff' />
                </TouchableOpacity>

                {!!image.caption && (
                    <View style={[st.captionWrap, { bottom: insets.bottom + 24 }]} pointerEvents='none'>
                        <Text style={st.caption} numberOfLines={2}>{image.caption}</Text>
                        <Text style={st.hint}>Pinch to zoom · double-tap</Text>
                    </View>
                )}
            </GestureHandlerRootView>
        </Modal>
    );
};

const st = StyleSheet.create({
    root: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
    stage: { alignItems: 'center', justifyContent: 'center' },
    spinner: { position: 'absolute' },
    closeBtn: {
        position: 'absolute',
        right: 16,
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.14)',
    },
    captionWrap: { position: 'absolute', left: 24, right: 24, alignItems: 'center', gap: 4 },
    caption: { color: '#fff', fontSize: 15, fontWeight: '600', textAlign: 'center' },
    hint: { color: 'rgba(255,255,255,0.55)', fontSize: 12 },
});

export default ImageViewer;
