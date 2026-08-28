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

// ─── RGB ⇄ HSL, "#RRGGBB" out ────────────────────────────────────────────────
const rgbToHsl = (r, g, b) => {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return { h: h / 6, s, l };
};

const hslToRgb = (h, s, l) => {
    if (s === 0) { const v = Math.round(l * 255); return { r: v, g: v, b: v }; }
    const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return {
        r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
        g: Math.round(hue2rgb(p, q, h) * 255),
        b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
    };
};

const rgbToHex = ({ r, g, b }) =>
    '#' + [r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Header tint bands. The hue of the cover is kept; saturation is capped and
// lightness pinned to a narrow band so the header is always a calm surface
// the text sits on — never the cover's raw colour (a pure yellow or magenta
// filling the top of the screen reads as a warning banner).
const HEADER_BAND = {
    dark:  { maxS: 0.45, minL: 0.16, maxL: 0.30 },
    paper: { maxS: 0.40, minL: 0.74, maxL: 0.86 },
};

/** Cover colour → header background for the given theme. Returns
 *  { hex, isDark } (isDark from the softened colour's luminance, so the
 *  caller's text-colour logic stays generic). */
export const softenForHeader = (hex, darkTheme) => {
    const band = darkTheme ? HEADER_BAND.dark : HEADER_BAND.paper;
    const { r, g, b } = hexToRgb(hex);
    const { h, s, l } = rgbToHsl(r, g, b);
    const rgb = hslToRgb(h, Math.min(s, band.maxS), clamp(l, band.minL, band.maxL));
    return { hex: rgbToHex(rgb), isDark: luminance(rgb.r, rgb.g, rgb.b) < 0.35 };
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
