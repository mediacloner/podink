/**
 * dictionaryHtml.js — turns a dictionary record's HTML into flat, themeable
 * paragraphs, and finds a phrasal verb's definition inside an entry.
 *
 * The twelve penReader dictionaries are Kindle conversions: presentational
 * HTML (`<b>`, `<i>`, `<font color>`, `<blockquote>`, `<div width="-50">`,
 * `<br/>`, `<table bgcolor>`), no CSS, no images. There is no WebView in
 * the card, so instead of styling that HTML we reduce it to a list of
 * paragraphs — each a run list carrying only the flags the renderer knows
 * how to draw (bold, italic, label, big, sup/sub, colour, link, example) —
 * plus an indent level from the nesting of block elements. Colours from
 * the publisher are not kept: a flag says "this was coloured" and the
 * renderer paints it with the theme's accent, so the same entry reads
 * correctly on the dark and the paper palettes.
 *
 * `findPhrase` ports the pen's phrasal-verb locator: an entry mentions
 * "give up" in passing several times before defining it; the definition is
 * where the phrase is set bold and the bold run is the phrase itself
 * (Collins: `<b>give up</b>` beside PHRASAL VERB; Oxford: `<b>give up
 * something</b>`). Pure module — no React, no native imports.
 */

// ── Entities ─────────────────────────────────────────────────────────────────

const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
    bull: '•', middot: '·', deg: '°', sect: '§', para: '¶', copy: '©', reg: '®', trade: '™',
    times: '×', divide: '÷', plusmn: '±', frac12: '½', frac14: '¼', frac34: '¾', laquo: '«', raquo: '»',
    iexcl: '¡', iquest: '¿', shy: '', ensp: ' ', emsp: ' ', thinsp: ' ', zwj: '', zwnj: '',
    eacute: 'é', egrave: 'è', ecirc: 'ê', aacute: 'á', agrave: 'à', acirc: 'â', atilde: 'ã', auml: 'ä',
    iacute: 'í', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', uacute: 'ú', uuml: 'ü', ntilde: 'ñ',
    ccedil: 'ç', Eacute: 'É', Aacute: 'Á', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Ccedil: 'Ç',
    euml: 'ë', iuml: 'ï', aring: 'å', oslash: 'ø', szlig: 'ß', aelig: 'æ', oelig: 'œ', larr: '←', rarr: '→',
};

export const decodeEntities = (s) => {
    if (!s || s.indexOf('&') < 0) return s || '';
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
            try { return String.fromCodePoint(code); } catch (_) { return ''; }
        }
        const v = NAMED_ENTITIES[body];
        return v === undefined ? m : v;
    });
};

// ── Tolerant HTML parser ─────────────────────────────────────────────────────

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'wbr', 'area', 'base', 'col', 'embed', 'source', 'track', 'param']);
const BLOCK_TAGS = new Set([
    'p', 'div', 'blockquote', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th', 'li', 'ul', 'ol', 'dl', 'dt', 'dd',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'main', 'aside', 'header', 'footer', 'nav', 'center',
    'pre', 'hide', 'body', 'html', 'form', 'fieldset', 'address', 'figure', 'figcaption', 'mbp:pagebreak',
]);
// Block tags that nest content one level deeper (senses under senses).
const INDENT_TAGS = new Set(['blockquote', 'li', 'dd', 'td', 'th']);
const SKIP_TAGS = new Set(['script', 'style', 'head', 'title', 'img', 'input', 'select', 'textarea', 'button', 'object', 'iframe']);

const ATTR_RE = /([^\s=\/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

const parseAttrs = (s) => {
    const attrs = {};
    if (!s) return attrs;
    let m;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(s))) {
        attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
    }
    return attrs;
};

/**
 * Parses HTML into { type:'el', tag, attrs, children } / { type:'text', text }
 * nodes. Forgiving: unclosed tags close at their parent's end, stray closers
 * are ignored, comments and processing instructions are dropped.
 */
export const parseHtml = (html) => {
    const root = { type: 'el', tag: '#root', attrs: {}, children: [] };
    const stack = [root];
    const src = String(html || '');
    const len = src.length;
    let i = 0;
    const pushText = (text) => {
        if (!text) return;
        stack[stack.length - 1].children.push({ type: 'text', text });
    };
    while (i < len) {
        const lt = src.indexOf('<', i);
        if (lt < 0) { pushText(src.slice(i)); break; }
        if (lt > i) pushText(src.slice(i, lt));
        if (src.startsWith('<!--', lt)) {
            const end = src.indexOf('-->', lt + 4);
            i = end < 0 ? len : end + 3;
            continue;
        }
        if (src[lt + 1] === '!' || src[lt + 1] === '?') {
            const end = src.indexOf('>', lt);
            i = end < 0 ? len : end + 1;
            continue;
        }
        const gt = src.indexOf('>', lt + 1);
        if (gt < 0) { pushText(src.slice(lt)); break; }
        const raw = src.slice(lt + 1, gt);
        i = gt + 1;
        if (!raw || !/^\/?[a-zA-Z]/.test(raw)) { pushText('<' + raw + '>'); continue; }
        if (raw[0] === '/') {
            const tag = raw.slice(1).trim().toLowerCase();
            // Close the nearest open element with this tag (and everything inside it).
            for (let s = stack.length - 1; s > 0; s--) {
                if (stack[s].tag === tag) { stack.length = s; break; }
            }
            continue;
        }
        const selfClosing = raw.endsWith('/');
        const body = selfClosing ? raw.slice(0, -1) : raw;
        const sp = body.search(/[\s\/]/);
        const tag = (sp < 0 ? body : body.slice(0, sp)).toLowerCase();
        const attrs = parseAttrs(sp < 0 ? '' : body.slice(sp));
        const el = { type: 'el', tag, attrs, children: [] };
        if (SKIP_TAGS.has(tag)) {
            // Drop the element and, for container tags, its content.
            if (!VOID_TAGS.has(tag) && !selfClosing) {
                const close = src.indexOf(`</${tag}`, i);
                if (close >= 0) {
                    const closeEnd = src.indexOf('>', close);
                    i = closeEnd < 0 ? len : closeEnd + 1;
                }
            }
            continue;
        }
        stack[stack.length - 1].children.push(el);
        if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(el);
    }
    return root;
};

// ── Flattening ───────────────────────────────────────────────────────────────

const FONT_SIZE_SCALE = {
    '1': 0.8, '2': 0.85, '3': 1, '4': 1, '5': 1.15, '6': 1.3, '7': 1.45,
    '-3': 0.7, '-2': 0.8, '-1': 0.88, '+1': 1.15, '+2': 1.3, '+3': 1.45, '+4': 1.6,
};

const MAX_INDENT = 4;
const LINK_PREFIX = /^(entry|bword):\/\//i;

const emptyStyle = () => ({
    b: false, i: false, u: false, small: false, big: false, sup: false, sub: false,
    color: false, link: null, example: false, size: 1,
});

/**
 * Flattens a record's HTML into paragraphs.
 *
 * @param {string} html
 * @param {object} [opts]
 * @param {string} [opts.styleKey]  per-dictionary tweaks ('mw-bilingual' turns
 *        `<…>` text into example runs; 'oald' drops the MENU block)
 * @returns {{ paragraphs: Array<{kind:'p'|'hr'|'box', indent:number, headword:boolean,
 *            runs: Array<{text:string, b,i,u,small,big,sup,sub,color:boolean, link:string|null, example:boolean, size:number}>}> }}
 */
export const flattenEntry = (html, opts = {}) => {
    const styleKey = opts.styleKey || '';
    const root = parseHtml(html);
    const paragraphs = [];
    let current = null;      // paragraph being filled
    let curIndent = 0;
    let curBox = 0;          // > 0 while inside a table[bgcolor]
    let pendingSpace = false;

    const openParagraph = () => {
        if (current) return current;
        current = { kind: curBox > 0 ? 'box' : 'p', indent: curIndent, headword: false, runs: [] };
        pendingSpace = false;
        return current;
    };
    const closeParagraph = () => {
        if (!current) return;
        // Trim trailing whitespace of the last run(s); drop empty paragraphs.
        while (current.runs.length) {
            const last = current.runs[current.runs.length - 1];
            last.text = last.text.replace(/\s+$/, '');
            if (last.text) break;
            current.runs.pop();
        }
        if (current.runs.length) paragraphs.push(current);
        current = null;
        pendingSpace = false;
    };
    const pushRule = () => {
        closeParagraph();
        paragraphs.push({ kind: 'hr', indent: curIndent, headword: false, runs: [] });
    };
    const sameStyle = (a, b) =>
        a.b === b.b && a.i === b.i && a.u === b.u && a.small === b.small && a.big === b.big &&
        a.sup === b.sup && a.sub === b.sub && a.color === b.color && a.link === b.link &&
        a.example === b.example && a.size === b.size;
    const pushText = (raw, style) => {
        let text = decodeEntities(raw).replace(/[\s\u00a0]+/g, ' ');
        if (!text) return;
        if (text === ' ') {
            if (current && current.runs.length) pendingSpace = true;
            return;
        }
        const para = openParagraph();
        if (pendingSpace && !text.startsWith(' ')) text = ' ' + text;
        pendingSpace = false;
        if (!para.runs.length) text = text.replace(/^\s+/, '');
        if (!text) return;
        const last = para.runs[para.runs.length - 1];
        if (last && sameStyle(last, style)) { last.text += text; return; }
        para.runs.push({ ...style, text });
    };

    const walk = (node, style) => {
        if (node.type === 'text') { pushText(node.text, style); return; }
        const tag = node.tag;
        const attrs = node.attrs;
        if (tag === 'br') { closeParagraph(); return; }
        if (tag === 'hr') { pushRule(); return; }
        if (tag === 'hide' && styleKey === 'oald' && /^menu$/i.test(attrs.label || '')) return;
        if (tag === 'a' && /^sound:\/\//i.test(attrs.href || '')) return; // no media in these files

        let next = style;
        const isBlock = BLOCK_TAGS.has(tag);
        if (!isBlock) {
            next = { ...style };
            switch (tag) {
                case 'b': case 'strong': case 'dfn': next.b = true; break;
                case 'i': case 'em': case 'cite': case 'var': next.i = true; break;
                case 'u': next.u = true; break;
                case 'small': next.small = true; break;
                case 'big': next.big = true; break;
                case 'sup': next.sup = true; break;
                case 'sub': next.sub = true; break;
                case 'a':
                    if (LINK_PREFIX.test(attrs.href || '')) next.link = decodeEntities(attrs.href.replace(LINK_PREFIX, '')).split('#')[0].trim();
                    break;
                case 'font':
                    if (attrs.color) next.color = true;
                    if (attrs.size && FONT_SIZE_SCALE[attrs.size.trim()]) next.size = Math.round(next.size * FONT_SIZE_SCALE[attrs.size.trim()] * 100) / 100;
                    break;
                case 'span':
                    if (attrs.class && /\b(ex|example|translation-example)\b/i.test(attrs.class)) next.example = true;
                    break;
                default: break;
            }
        }

        if (isBlock) {
            closeParagraph();
            const prevIndent = curIndent;
            const prevBox = curBox;
            const indents = INDENT_TAGS.has(tag) || (tag === 'div' && attrs.width != null) || (tag === 'p' && attrs.indent != null && attrs.depth != null && attrs.depth !== '1');
            if (indents) curIndent = Math.min(MAX_INDENT, curIndent + 1);
            if (tag === 'table' && attrs.bgcolor) curBox++;
            for (const child of node.children) walk(child, next);
            closeParagraph();
            curIndent = prevIndent;
            curBox = prevBox;
            return;
        }
        for (const child of node.children) walk(child, next);
    };

    walk(root, emptyStyle());
    closeParagraph();

    // Trailing rules carry nothing (pen: `.entry>hr:last-child{display:none}`).
    while (paragraphs.length && paragraphs[paragraphs.length - 1].kind === 'hr') paragraphs.pop();
    while (paragraphs.length && paragraphs[0].kind === 'hr') paragraphs.shift();

    // The first paragraph of a record is its headword line — the pen's
    // `.entry>*:first-of-type` rule — and gets the display treatment.
    const firstText = paragraphs.find(p => p.kind !== 'hr');
    if (firstText) firstText.headword = true;

    if (styleKey === 'mw-bilingual') decorateAngleExamples(paragraphs);
    return { paragraphs };
};

// Merriam-Webster's bilingual entries delimit their examples with literal
// angle brackets: `<she ran to catch the bus : corrió para alcanzar el autobús>`.
const decorateAngleExamples = (paragraphs) => {
    for (const p of paragraphs) {
        const out = [];
        let inside = false;
        for (const run of p.runs) {
            const parts = run.text.split(/([<>])/);
            for (const part of parts) {
                if (part === '<') { inside = true; continue; }
                if (part === '>') { inside = false; continue; }
                if (!part) continue;
                out.push({ ...run, text: part, example: inside || run.example });
            }
        }
        p.runs = out.filter(r => r.text);
    }
};

// ── Plain text & phrasal-verb locator ────────────────────────────────────────

export const paragraphText = (p) => p.runs.map(r => r.text).join('');

/** Plain text of a flattened entry, paragraphs joined by newlines. */
export const entryPlainText = (flat) =>
    flat.paragraphs.filter(p => p.kind !== 'hr').map(paragraphText).join('\n');

/** The first definition-ish line after the headword — for the vocabulary row. */
export const firstDefinitionText = (flat, maxLen = 240) => {
    const p = flat.paragraphs.find(x => x.kind !== 'hr' && !x.headword);
    if (!p) return '';
    const text = paragraphText(p).replace(/\s+/g, ' ').trim();
    return text.length > maxLen ? text.slice(0, maxLen - 1).trimEnd() + '…' : text;
};

const isWordChar = (ch) => !!ch && /[\p{L}\p{N}]/u.test(ch);

// Words a dictionary appends to a phrasal-verb heading in place of the object:
// "give up something", "look sb up", "turn (someone) out". Particles are
// deliberately absent — "give up on" and "look up to" are other verbs.
const PLACEHOLDERS = new Set([
    'sb', 'sth', 'somebody', 'something', 'someone', 'sb/sth', 'somebody/something', 'someone/something',
    'yourself', 'oneself', 'himself', 'herself', 'itself', 'themselves', 'somewhere', 'doing',
    'one', "one's", 'your', 'his', 'her', 'their', 'its', 'a', 'an', 'the', 'or',
]);

const normalizeSpace = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

// Characters that sit inside a phrase without being part of it: Oxford's
// stress marks ("ˌlook ˈup"), syllable dots, soft hyphens, zero-widths.
const TRANSPARENT = /[\u02c8\u02cc\u00b7\u2027\u30fb\u00ad\u200b\u200c\u200d\ufeff]/;

/**
 * Lower-cases `text` for searching with the transparent characters removed,
 * and a map from every index of the normalized string back to the original
 * so a hit can be highlighted where it really is.
 */
export const normalizeForSearch = (text) => {
    let norm = '';
    const map = [];
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (TRANSPARENT.test(ch)) continue;
        const low = ch.toLowerCase();
        norm += low.length === 1 ? low : ch;
        map.push(i);
    }
    map.push(text.length);
    return { norm, map };
};

// A phrasal-verb heading, reduced to its words: leading bullet / "to" gone
// ("• to look up", "▪ give up"), stress marks and brackets removed.
const headingWords = (boldText) => normalizeForSearch(boldText).norm
    .replace(/^[\s•▪▸►▶·◆■□●○◇*→➤➔-]+/, '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')   // optional complements: "(from sth)", "[on sb]"
    .replace(/[~:;,.!?]/g, ' ')
    .replace(/^\s*to\s+/, '')
    .replace(/\s+/g, ' ').trim();

// Does a bold run read as a heading for `phrase`? Equal, or the phrase plus
// object placeholders only ("give up something", "turn someone out",
// "look (something) up"), never plus another particle.
const headingMatches = (boldText, phrase) => {
    const b = headingWords(boldText);
    if (b === phrase) return true;
    const pw = phrase.split(' ');
    const bw = b.split(' ');
    if (bw.length < pw.length) return false;
    // Walk the phrase words through the heading, skipping placeholders.
    let i = 0;
    for (const w of bw) {
        if (i < pw.length && w === pw[i]) i++;
        else if (!PLACEHOLDERS.has(w)) return false;
    }
    return i === pw.length;
};

/**
 * Finds where `phrase` ("give up") is defined inside a flattened entry:
 * the occurrence set in a bold run that is the phrase itself (optionally
 * with an object placeholder). Returns { paraIndex, start, end, heading:true }
 * for a heading, or — when `allowLoose` — the first bold, then the first
 * plain occurrence with heading:false. Null when the phrase is absent.
 */
export const findPhrase = (flat, phrase, { allowLoose = false } = {}) => {
    const needle = normalizeSpace(normalizeForSearch(phrase).norm);
    if (!needle) return null;
    let firstBold = null;
    let firstAny = null;
    const paragraphs = flat.paragraphs;
    for (let pi = 0; pi < paragraphs.length; pi++) {
        const p = paragraphs[pi];
        if (p.kind === 'hr') continue;
        // Character ranges of maximal bold runs in this paragraph.
        const bolds = [];
        let pos = 0;
        let openBold = null;
        for (const r of p.runs) {
            if (r.b) {
                if (!openBold) openBold = { start: pos, end: pos + r.text.length, text: r.text };
                else { openBold.end = pos + r.text.length; openBold.text += r.text; }
            } else if (openBold) {
                // Whitespace-only gaps between bold pieces keep the run going.
                if (/^\s*$/.test(r.text)) { openBold.end = pos + r.text.length; openBold.text += r.text; }
                else { bolds.push(openBold); openBold = null; }
            }
            pos += r.text.length;
        }
        if (openBold) bolds.push(openBold);
        const text = paragraphText(p);
        const { norm, map } = normalizeForSearch(text);
        let at = norm.indexOf(needle);
        while (at >= 0) {
            const endN = at + needle.length;
            if (!isWordChar(norm[at - 1]) && !isWordChar(norm[endN])) {
                const start = map[at];
                const end = map[endN];
                const hit = { paraIndex: pi, start, end, heading: false };
                const bold = bolds.find(b => b.start <= start && end <= b.end);
                if (bold) {
                    if (headingMatches(bold.text, needle)) return { ...hit, heading: true };
                    if (!firstBold) firstBold = hit;
                }
                if (!firstAny) firstAny = hit;
            }
            at = norm.indexOf(needle, at + 1);
        }
    }
    if (!allowLoose) return null;
    return firstBold || firstAny;
};
