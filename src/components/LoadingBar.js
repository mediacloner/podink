import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
    Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming,
} from 'react-native-reanimated';
import { useStyles } from '../theme';

// Thin indeterminate progress line — sits directly under a screen header while
// something loads in the background (feed refresh, adding a feed). Purely
// informational: it never blocks touches, so the user can keep browsing or
// switch tabs while it runs. Renders nothing when not visible.
const SEGMENT_FRACTION = 0.38;
const SWEEP_MS = 1100;

const LoadingBar = ({ visible }) => {
    const styles = useStyles(makeStyles);
    const [width, setWidth] = useState(0);
    const progress = useSharedValue(0);

    useEffect(() => {
        if (!visible) {
            cancelAnimation(progress);
            return undefined;
        }
        progress.value = 0;
        progress.value = withRepeat(
            withTiming(1, { duration: SWEEP_MS, easing: Easing.inOut(Easing.quad) }),
            -1,
            false,
        );
        return () => cancelAnimation(progress);
    }, [visible, progress]);

    const segment = width * SEGMENT_FRACTION;
    const sweep = useAnimatedStyle(() => ({
        width: segment,
        transform: [{ translateX: -segment + progress.value * (width + segment) }],
    }), [width, segment]);

    if (!visible) return null;
    return (
        <View
            style={styles.track}
            onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
            pointerEvents="none"
            accessibilityRole="progressbar"
            accessibilityLabel="Loading"
        >
            {width > 0 && <Animated.View style={[styles.segment, sweep]} />}
        </View>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    track: {
        height: 2,
        backgroundColor: colors.hairline,
        overflow: 'hidden',
    },
    segment: {
        height: 2,
        borderRadius: 1,
        backgroundColor: colors.accent,
    },
});

export default LoadingBar;
