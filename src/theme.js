// Central design tokens for Podink. All colors, spacing, radii and type
// styles must come from here — do not hardcode hex values in components.

export const colors = {
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

    // Hairlines
    hairline: 'rgba(255,255,255,0.08)',
    hairlineFaint: 'rgba(255,255,255,0.04)',
    hairlineStrong: 'rgba(255,255,255,0.12)',

    // Transcript reading palette (warm, low-glare)
    transcriptFuture: '#3A3530',
    transcriptSpoken: '#A09078',
    transcriptActive: '#FFF6E8',
    transcriptGlow: 'rgba(79,172,254,0.75)',
};

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
