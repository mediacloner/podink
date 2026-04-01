/**
 * Extracts the dominant colour from a remote image URL using native platform APIs.
 *
 * iOS  → UIImageColors (via react-native-image-colors)
 * Android → Palette API (via react-native-image-colors)
 *
 * Requires: npx expo install react-native-image-colors
 * Then rebuild the dev client.
 */
import ImageColors from 'react-native-image-colors';
import { Platform } from 'react-native';

// ─── sRGB luminance ───────────────────────────────────────────────────────────
const lin = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const luminance = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

// ─── Parse "#RRGGBB" → { r, g, b } ───────────────────────────────────────────
const hexToRgb = (hex) => {
    const h = hex.replace('#', '');
    return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
    };
};

// ─── Main export ──────────────────────────────────────────────────────────────
export const extractColor = async (imageUrl) => {
    if (!imageUrl) return null;
    try {
        const result = await ImageColors.getColors(imageUrl, {
            fallback: '#1A1628',
            cache: true,
            quality: 'low',       // faster; low is sufficient for background colour
            pixelSpacing: 5,      // Android: sample every 5th pixel
        });

        // Pick the most representative colour per platform.
        // iOS returns UIImageColors fields; Android returns Palette API fields.
        let hex;
        if (result.platform === 'ios') {
            // `background` = most prevalent colour in the image (best for header bg)
            hex = result.background ?? result.primary ?? '#1A1628';
        } else if (result.platform === 'android') {
            // Prefer vibrant (vivid), fall back to dominant (most common)
            hex = result.vibrant ?? result.dominant ?? '#1A1628';
        } else {
            hex = result.dominant ?? '#1A1628';
        }

        const { r, g, b } = hexToRgb(hex);
        const lum    = luminance(r, g, b);
        const isDark = lum < 0.35;

        return { r, g, b, isDark, bgColor: hex };
    } catch (_) {
        return null;
    }
};
