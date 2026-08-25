// Central design tokens for Podink. All colors, spacing, radii and type
// styles must come from here — do not hardcode hex values in components.
//
// Colors are themed. Components never import a static palette; they call
//   const { colors } = useTheme();          // for inline colors (icons, props)
//   const styles = useStyles(makeStyles);   // makeStyles = (colors) => StyleSheet.create({...})
// `useStyles` builds each StyleSheet once per theme and shares it across all
// instances, so the cost is the same as a module-level StyleSheet.create.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const THEME_KEY = '@theme';
export const DEFAULT_THEME = 'dark';

// ─── Palettes ─────────────────────────────────────────────────────────────────

const dark = {
    // Base surfaces
    bg: '#0C0C0E',
    bgPlayer: '#0B0A11',
    surface: '#141416',
    surfaceElevated: '#1C1C1E',
    surfaceHigh: '#222226',

    // Brand + status
    accent: '#4FACFE',
    danger: '#FF453A',
    success: '#34C759',
    warning: '#FF9F0A',
    purple: '#AF82FF',
    indigo: '#636DAE',

    // Text
    textPrimary: '#FFFFFF',
    textSecondary: '#AEAEB2',
    textMuted: '#636366',
    textFaint: '#3A3A3C',
    // Text / icons drawn on a solid accent, danger or indigo fill
    onAccent: '#FFFFFF',

    // Hairlines
    hairline: 'rgba(255,255,255,0.08)',
    hairlineFaint: 'rgba(255,255,255,0.04)',
    hairlineStrong: 'rgba(255,255,255,0.12)',

    // Dim layer behind sheets and alerts
    backdrop: 'rgba(0,0,0,0.7)',

    // Transcript reading palette (warm, low-glare). The current word glows
    // (text shadow); the highlight band is off (alpha 0).
    transcriptFuture: '#3A3530',
    transcriptSpoken: '#A09078',
    transcriptActive: '#FFF6E8',
    transcriptGlow: 'rgba(79,172,254,0.75)',
    transcriptGlowRadius: 14,
    transcriptHighlight: '#4FACFE',
    transcriptHighlightAlpha: 0,
};

// "Paper": the app icon's sticker — cream stock (#F3F0E9) and ink — turned into
// a reading surface. Cards are lighter sheets laid on the page, text is warm
// ink rather than pure black, the accent is fountain-pen blue-black, and the
// active transcript word gets a highlighter-pen mark instead of a blue glow.
const paper = {
    // Base surfaces
    bg: '#F3F0E9',
    bgPlayer: '#F5F0E4',
    surface: '#FAF8F3',
    surfaceElevated: '#FFFDF8',
    surfaceHigh: '#E5DFD3',

    // Brand + status (darkened for AA contrast on cream)
    accent: '#2F5D9E',
    danger: '#B3261E',
    success: '#2E7D32',
    warning: '#B26A00',
    purple: '#6B4FBB',
    indigo: '#4A5590',

    // Text — warm ink
    textPrimary: '#1B1814',
    textSecondary: '#5A534A',
    textMuted: '#8A8276',
    textFaint: '#B8B0A3',
    onAccent: '#F3F0E9',

    // Hairlines — ink at low alpha
    hairline: 'rgba(27,24,20,0.10)',
    hairlineFaint: 'rgba(27,24,20,0.06)',
    hairlineStrong: 'rgba(27,24,20,0.16)',

    backdrop: 'rgba(27,24,20,0.45)',

    // Transcript: unread text is faded print, read text is body ink, the
    // current word is the deepest ink on a highlighter-yellow band. No glow —
    // a blurred shadow on a light page reads as a smudge.
    transcriptFuture: '#ABA294',
    transcriptSpoken: '#3F3931',
    transcriptActive: '#0F0D0B',
    transcriptGlow: 'transparent',
    transcriptGlowRadius: 0,
    transcriptHighlight: '#FFD24D',
    transcriptHighlightAlpha: 0.55,
};

export const THEMES = { dark, paper };

// Presentation data for the Settings selector, in display order.
export const THEME_OPTIONS = [
    { id: 'dark',  label: 'Dark',  icon: 'moon',      hint: 'Low-glare, for listening at night' },
    { id: 'paper', label: 'Paper', icon: 'book-open', hint: 'Cream page and ink, like a printed book' },
];

// ─── Provider / hooks ─────────────────────────────────────────────────────────

const ThemeContext = createContext({
    themeName: DEFAULT_THEME,
    colors: THEMES[DEFAULT_THEME],
    isDark: true,
    ready: false,
    setTheme: () => {},
});

export const ThemeProvider = ({ children }) => {
    const [themeName, setThemeName] = useState(DEFAULT_THEME);
    // False until the stored preference has been read; the native splash is
    // dark, so rendering the dark default in the meantime never flashes.
    const [ready, setReady] = useState(false);

    useEffect(() => {
        let alive = true;
        AsyncStorage.getItem(THEME_KEY)
            .then((saved) => { if (alive && THEMES[saved]) setThemeName(saved); })
            .catch(() => {})
            .finally(() => { if (alive) setReady(true); });
        return () => { alive = false; };
    }, []);

    const setTheme = useCallback((name) => {
        if (!THEMES[name]) return;
        setThemeName(name);
        AsyncStorage.setItem(THEME_KEY, name).catch(() => {});
    }, []);

    const value = useMemo(() => ({
        themeName,
        colors: THEMES[themeName],
        isDark: themeName === 'dark',
        ready,
        setTheme,
    }), [themeName, ready, setTheme]);

    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = () => useContext(ThemeContext);

// One StyleSheet per (palette, makeStyles) pair, shared by every instance.
const styleCache = new WeakMap();

export function useStyles(makeStyles) {
    const { colors } = useTheme();
    let perTheme = styleCache.get(colors);
    if (!perTheme) {
        perTheme = new Map();
        styleCache.set(colors, perTheme);
    }
    let styles = perTheme.get(makeStyles);
    if (!styles) {
        styles = makeStyles(colors);
        perTheme.set(makeStyles, styles);
    }
    return styles;
}

// ─── Static tokens ────────────────────────────────────────────────────────────

// withAlpha('#4FACFE', 0.12) -> 'rgba(79,172,254,0.12)'
export function withAlpha(hex, alpha) {
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

export const spacing = { xs: 4, s: 8, m: 12, l: 16, xl: 20, xxl: 24 };

export const radii = { s: 12, m: 14, l: 18, xl: 20, pill: 999 };

export const type = {
    caption: { fontSize: 11, fontWeight: '600', letterSpacing: 0.6 },
    label: { fontSize: 12, fontWeight: '600' },
    body: { fontSize: 13, fontWeight: '400' },
    bodyStrong: { fontSize: 13, fontWeight: '600' },
    title: { fontSize: 15, fontWeight: '600' },
    heading: { fontSize: 17, fontWeight: '700', letterSpacing: -0.3 },
    display: { fontSize: 20, fontWeight: '700', letterSpacing: -0.3 },
};
