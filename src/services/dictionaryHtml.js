/**
 * dictionaryHtml.js — turns a dictionary record's HTML into flat, themeable
 * paragraphs, and finds a phrasal verb's definition inside an entry.
 *
 * Most of the penReader dictionaries are Kindle conversions: presentational
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
 * LDOCE 6 and Vocabulary.com are prepared MDict sets instead, styled by
 * publisher CSS classes, and the two Oxford Quick Reference books (Word
 * Origins and Idioms, penReader revision 2.21) keep OUP's paragraph
 * classes from their EPUB conversion; the 'ldoce', 'vocab',
 * 'oxford-origins' and 'oxford-idioms' style keys map those classes onto
 * the same run flags (see CLASS_PROFILES), following the pen's WebView
 * profiles in penReader's scan-bridge. LDOCE additionally
 * gets its popup blocks stripped before parsing — 91% of a raw record is
 * `<div nattr="at-link">` content (Word Origin, Collocations, Thesaurus)
 * that only ever appears when the publisher's JavaScript runs; inline it
 * buries the entry (the pen strips it at index-build time instead, in
 * tools/mdx_index.py).
 *
 * `findPhrase` ports the pen's phrasal-verb locator: an entry mentions
 * "give up" in passing several times before defining it; the definition is
 * where the phrase is set bold and the bold run is the phrase itself
 * (Collins: `<b>give up</b>` beside PHRASAL VERB; Oxford: `<b>give up
 * something</b>`). `findHeadingInContext` goes the other way for idioms
 * filed under a keyword: which bold heading of the entry occurs in the
 * words around the tap. Pure module — no React, no native imports.
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

/** The text content of a parsed node, tags dropped. */
const nodeText = (n) => (n.type === 'text' ? n.text : n.children.map(nodeText).join(''));

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

// ── LDOCE 6 popup strip ──────────────────────────────────────────────────────

const LDOCE_ATLINK_OPEN = /<div\s+nattr="at-link"[^>]*>/gi;
const ANY_DIV = /<\/?div\b[^>]*>/gi;

/** Removes every `<div nattr="at-link">…</div>` block (depth-matched). */
const dropAtLinkDivs = (html) => {
    LDOCE_ATLINK_OPEN.lastIndex = 0;
    let m = LDOCE_ATLINK_OPEN.exec(html);
    if (!m) return html;
    const parts = [];
    let keepFrom = 0;
    while (m) {
        parts.push(html.slice(keepFrom, m.index));
        ANY_DIV.lastIndex = LDOCE_ATLINK_OPEN.lastIndex;
        let depth = 1;
        let end = html.length;
        let t;
        while ((t = ANY_DIV.exec(html))) {
            depth += t[0][1] === '/' ? -1 : 1;
            if (depth === 0) { end = ANY_DIV.lastIndex; break; }
        }
        keepFrom = end;
        LDOCE_ATLINK_OPEN.lastIndex = end;
        m = LDOCE_ATLINK_OPEN.exec(html);
    }
    parts.push(html.slice(keepFrom));
    return parts.join('');
};

// ── Per-dictionary class profiles ────────────────────────────────────────────
// A profile looks at an element's tag and class tokens (and at its parent
// element, for the few rules that need it) and answers { skip, block,
// indent, box, flags, linkText, spaceAfter } — skip drops the element and
// its content, block starts a new paragraph, indent nests it, box renders
// its paragraphs as a tinted card, flags extend the run style for its
// subtree, linkText makes the element a tappable cross-reference to its own
// text, spaceAfter adds the space the publisher left to CSS.

const classTokens = (attrs) => String(attrs.class || '').trim().split(/\s+/).filter(Boolean);

// LDOCE marks everything semantically; a straight remap of the publisher's
// classes, mirroring the pen's ldoce6 profile. `.hwd` stays hidden exactly as
// their stylesheet hides it — `.hyphenation` is the visible headword. The
// `buttons` span holds only the dead popup-button labels once the at-link
// blocks are gone.
const LDOCE_SKIP = new Set(['hwd', 'imgholder', 'buttons', 'popup-button']);
const LDOCE_BLOCK = new Set(['chwd', 'entryhead', 'sense', 'subsense', 'newline', 'phrvbhwd',
    'example', 'gramexa', 'colloexa', 'f2nbox', 'thesbox', 'collobox', 'grambox', 'usagebox', 'etymbox', 'errorbox']);
const LDOCE_FLAGS = {
    hyphenation: { b: true, big: true },
    phrvbhwd: { b: true, color: true },   // "run out somebody/something" — the pen's .phrvbhwd rule
    kw: { b: true }, hw: { b: true },
    homnum: { sup: true, color: true },
    proncodes: { color: true }, pron: { color: true }, neutral: { color: true }, amevarpron: { color: true },
    level: { small: true }, freq: { small: true },
    pos: { i: true, color: true }, gram: { i: true, color: true },
    registerlab: { small: true }, geo: { small: true },
    sensenum: { b: true, color: true },
    signpost: { small: true, b: true },
    example: { example: true }, gramexa: { example: true }, colloexa: { example: true },
    collo: { b: true, color: true }, colloc: { b: true, color: true }, collocate: { b: true, color: true },
    lexunit: { b: true, color: true }, propform: { b: true, color: true },
    refhwd: { color: true }, crossref: { color: true }, linkword: { color: true },
};

const ldoceProfile = (tag, attrs) => {
    const tokens = classTokens(attrs);
    if (!tokens.length) return null;
    let out = null;
    for (const t of tokens) {
        if (LDOCE_SKIP.has(t)) return { skip: true };
        if (LDOCE_BLOCK.has(t)) (out = out || {}).block = true;
        const flags = LDOCE_FLAGS[t];
        if (flags) (out = out || {}).flags = { ...out.flags, ...flags };
        if (t === 'subsense') (out = out || {}).indent = true;
        if (t === 'chwd') (out = out || {}).flags = { ...out.flags, small: true };
        // The publisher spaces sense numbers with min-width, not text.
        if (t === 'sensenum') (out = out || {}).spaceAfter = true;
    }
    return out;
};

// Vocabulary.com minifies its classes; these are the ones v.css gives meaning
// to (the pen's vocab profile): `.b.t` headword, `.a.g.d` frequency line,
// div`.h` the sense-nav row, `.i.t.s` the short sense with `.s` the marked
// word, `.a.i` the plain-English paragraph, `span.b.c` section headings,
// `.n` a press example with `.g.r` its source. `.s_` is the dead "+"
// expander and span`.h` its collapse glyph.
const vocabProfile = (tag, attrs) => {
    const tokens = classTokens(attrs);
    if (!tokens.length) return null;
    const set = new Set(tokens);
    // Dead JavaScript controls: the "+" word-family expander with its "/"
    // collapse glyph, and the Hypo|Hyper tab row of the relations tree.
    if (set.has('s_') || set.has('y_')) return { skip: true };
    if (tag === 'div' && tokens.length === 1 && set.has('y')) return { skip: true };
    if (tag === 'span' && tokens.length === 1 && set.has('h')) return { skip: true };
    if (set.has('b') && set.has('t')) return { block: true, flags: { b: true, big: true } };
    if (set.has('a') && set.has('g') && set.has('d')) return { block: true, flags: { small: true } };
    if (tag === 'div' && tokens.length === 1 && set.has('h')) return { block: true, flags: { small: true } };
    if (set.has('i') && set.has('t') && set.has('s')) return { block: true };
    if (set.has('b') && set.has('c')) return { block: true, flags: { small: true, b: true } };
    if (set.has('b') && set.has('g')) return { flags: { b: true, color: true } };
    if (set.has('g') && set.has('r')) return { flags: { small: true } };
    if (tag === 'a' && set.has('p') && set.has('n')) return { flags: { i: true, color: true } };
    if (tag === 'div' && tokens.length === 1 && set.has('n')) return { block: true, flags: { example: true } };
    if (tokens.length === 1 && set.has('g')) return { flags: { small: true } };
    if (tokens.length === 1 && set.has('s')) return { flags: { b: true, color: true } };
    if (tokens.length === 1 && (set.has('m') || set.has('o'))) return { flags: { b: true } };
    return null;
};

// The two Oxford Quick Reference books (penReader revision 2.21) were read
// from the publisher's EPUB by tools/epub2mdx.py: every record opens with
// the `<div class="hw">` the converter adds, then keeps OUP's classes. The
// rules mirror the pen's oxford-origins / oxford-idioms profiles.
const hasClass = (node, cls) => !!node && classTokens(node.attrs).includes(cls);
const OXFORD_HEADWORD = { block: true, flags: { b: true, big: true } };
const OXFORD_PARAGRAPHS = new Set(['parafl', 'para', 'parax1', 'paraf1']);

// Word Origins: one running paragraph per entry, the date of first record in
// brackets (`.span`: [E19th]), the words explained in passing in bold, and
// cross-references in small caps (`.sc`) or marked by the converter
// (`.xref`) — followable here, unlike on the pen. Topic panels ("Acronyms")
// carry a `.panel` badge in their headword line.
const oxfordOriginsProfile = (tag, attrs) => {
    const tokens = classTokens(attrs);
    if (!tokens.length) return null;
    const set = new Set(tokens);
    if (set.has('hw')) return OXFORD_HEADWORD;
    if (set.has('panel')) return { flags: { b: false, big: false, small: true } };
    if (tokens.some(t => OXFORD_PARAGRAPHS.has(t))) return { block: true };
    if (set.has('span')) return { flags: { small: true } };
    if (set.has('sc') || set.has('xref')) return { flags: { color: true }, linkText: true };
    return null;
};

// Idioms: under a keyword, one `.para` per idiom — the idiom itself is the
// bold run opening the paragraph, its senses numbered by `.label` badges
// (the book's ❶ ❷ GIFs, rewritten as text by the converter), register in
// `.span` — then a `.paral` origin note and a `.prosequote` dated quotation.
// "see" lines name the keyword an idiom is filed under (`.sc`).
const oxfordIdiomsProfile = (tag, attrs, parent) => {
    if (tag === 'b') {
        if (hasClass(parent, 'para')) return { flags: { color: true } };   // the idiom heading
        if (hasClass(parent, 'name')) return { flags: { b: false } };      // quotation byline: not bold on the pen
        return null;
    }
    const tokens = classTokens(attrs);
    if (!tokens.length) return null;
    const set = new Set(tokens);
    if (set.has('hw')) return OXFORD_HEADWORD;
    if (set.has('para')) return { block: true };
    if (set.has('label')) return { flags: { b: true, color: true }, spaceAfter: true };
    if (set.has('paral')) return { block: true, box: true };
    if (set.has('prosequote')) return { block: true, indent: true, flags: { example: true } };
    // A register label beside the definition; inside a note `.span` wraps the whole text.
    if (set.has('span')) return hasClass(parent, 'para') ? { flags: { small: true } } : null;
    if (set.has('sc')) return { flags: { color: true }, linkText: true };
    return null;
};

const CLASS_PROFILES = {
    ldoce: ldoceProfile,
    vocab: vocabProfile,
    'oxford-origins': oxfordOriginsProfile,
    'oxford-idioms': oxfordIdiomsProfile,
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
    const source = styleKey === 'ldoce' ? dropAtLinkDivs(html) : html;
    const profile = CLASS_PROFILES[styleKey] || null;
    const root = parseHtml(source);
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

    const walk = (node, style, parent = null) => {
        if (node.type === 'text') { pushText(node.text, style); return; }
        const tag = node.tag;
        const attrs = node.attrs;
        if (tag === 'br') { closeParagraph(); return; }
        if (tag === 'hr') { pushRule(); return; }
        if (tag === 'hide' && styleKey === 'oald' && /^menu$/i.test(attrs.label || '')) return;
        if (tag === 'a' && /^sound:\/\//i.test(attrs.href || '')) return; // no media in these files

        const prof = profile ? profile(tag, attrs, parent) : null;
        if (prof && prof.skip) return;

        let next = style;
        const isBlock = BLOCK_TAGS.has(tag) || Boolean(prof && prof.block);
        if (!isBlock || (prof && (prof.flags || prof.linkText))) {
            next = { ...style };
            if (!isBlock) switch (tag) {
                case 'b': case 'strong': case 'dfn': next.b = true; break;
                case 'i': case 'em': case 'cite': case 'var': next.i = true; break;
                case 'u': next.u = true; break;
                case 'small': next.small = true; break;
                case 'big': next.big = true; break;
                case 'sup': next.sup = true; break;
                case 'sub': next.sub = true; break;
                case 'a':
                    if (LINK_PREFIX.test(attrs.href || '')) {
                        // An entry://#anchor link points inside this record; no target to offer.
                        const target = decodeEntities(attrs.href.replace(LINK_PREFIX, '')).split('#')[0].trim();
                        if (target) next.link = target;
                    }
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
            if (prof && prof.flags) Object.assign(next, prof.flags);
            if (prof && prof.linkText && !next.link) {
                // A cross-reference whose target is its own text ("see holding").
                const target = decodeEntities(nodeText(node)).replace(/\s+/g, ' ').trim();
                if (target) next.link = target;
            }
        }

        if (isBlock) {
            closeParagraph();
            const prevIndent = curIndent;
            const prevBox = curBox;
            const indents = INDENT_TAGS.has(tag) || (tag === 'div' && attrs.width != null) || (tag === 'p' && attrs.indent != null && attrs.depth != null && attrs.depth !== '1') || Boolean(prof && prof.indent);
            if (indents) curIndent = Math.min(MAX_INDENT, curIndent + 1);
            if ((tag === 'table' && attrs.bgcolor) || Boolean(prof && prof.box)) curBox++;
            for (const child of node.children) walk(child, next, node);
            closeParagraph();
            curIndent = prevIndent;
            curBox = prevBox;
            return;
        }
        for (const child of node.children) walk(child, next, node);
        if (prof && prof.spaceAfter) pushText(' ', style);
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
    "someone's", "somebody's", "sb's", "sth's", "something's",
    'yourself', 'oneself', 'himself', 'herself', 'itself', 'themselves', 'somewhere', 'doing',
    'one', "one's", 'your', 'his', 'her', 'their', 'its', 'a', 'an', 'the', 'or',
]);

// Function words: never reduced to a base form, and not what identifies an
// idiom (the pen's STOP list).
export const FUNCTION_WORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'so', 'yet', 'if', 'as', 'than', 'that', 'this', 'these', 'those',
    'i', 'me', 'my', 'mine', 'you', 'your', 'yours', 'he', 'him', 'his', 'she', 'her', 'hers', 'it', 'its',
    'we', 'us', 'our', 'ours', 'they', 'them', 'their', 'theirs', 'who', 'whom', 'whose', 'which', 'what',
    'be', 'am', 'is', 'are', 'was', 'were', 'been', 'being', 'do', 'does', 'did', 'have', 'has', 'had',
    'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
    'not', 'no', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'up', 'down', 'out', 'off',
    'over', 'into', 'about', 'there', 'here', 'then', 'when', 'where', 'how', 'why', 'all', 'any', 'some', 'very', 'just',
]);

const normalizeSpace = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

// Characters that sit inside a phrase without being part of it: Oxford's
// stress marks ("ˌlook ˈup"), syllable dots, soft hyphens, zero-widths.
const TRANSPARENT = /[\u02c8\u02cc\u00b7\u2027\u30fb\u00ad\u200b\u200c\u200d\ufeff]/;

/**
 * Lower-cases `text` for searching with the transparent characters removed
 * and curly apostrophes straightened ("someone’s" is "someone's"), and a
 * map from every index of the normalized string back to the original so a
 * hit can be highlighted where it really is.
 */
export const normalizeForSearch = (text) => {
    let norm = '';
    const map = [];
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (TRANSPARENT.test(ch)) continue;
        const low = ch === '’' || ch === '‘' ? "'" : ch.toLowerCase();
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
    .replace(/(^|\s)\d+(?=\s|$)/g, ' ')        // sense numbers set in bold beside the heading
    .replace(/^\s*to\s+/, '')
    .replace(/\s+/g, ' ').trim();

// The readings of a heading: with its brackets dropped, and each bracketed
// alternative on its own — "cross your fingers (or keep your fingers
// crossed)" is the heading of both.
const headingVariants = (boldText) => {
    const out = [headingWords(boldText)];
    const alt = /[([]\s*or\s+([^)\]]+)[)\]]/gi;
    let m;
    while ((m = alt.exec(boldText))) {
        const v = headingWords(m[1]);
        if (v && !out.includes(v)) out.push(v);
    }
    return out.filter(Boolean);
};

// Does a heading (as words) read as one for `phrase`? Equal, or the phrase
// plus object placeholders only ("give up something", "turn someone out",
// "look (something) up"), never plus another particle.
const wordsMatch = (b, phrase) => {
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

// Does a bold run read as a heading for `phrase`, in any of its readings?
const headingMatches = (boldText, phrase) => headingVariants(boldText).some(b => wordsMatch(b, phrase));

// Text that may sit between two bold pieces of one heading: whitespace, or
// the brackets of an alternative — "make (both) ends meet", "keep (or have)
// your fingers crossed", "with your back to (or up against) the wall" — so
// the heading is read whole and headingWords can drop the bracket.
const HEADING_GAP = /^\s*$|^\s*[([]\s*(?:or\s*)?$|^\s*[)\]]\s*$/i;
// What a gap may still grow into (text arrives run by run: " (", "or", " ").
const HEADING_GAP_PREFIX = /^\s*(?:[([]\s*(?:o|or\s*)?|[)\]]\s*)?$/i;
const CLOSING = /^\s*[)\]]/;

// Character ranges of the maximal bold runs in a paragraph: [{ start, end, text }].
const boldRuns = (p) => {
    const bolds = [];
    let pos = 0;
    let openBold = null;
    let gap = '';       // non-bold text since the open run's last bold piece
    const finish = () => {
        // A bracket closing right after the last bold piece belongs to the heading.
        const close = CLOSING.exec(gap);
        if (close) { openBold.text += close[0]; openBold.end += close[0].length; }
        bolds.push(openBold);
        openBold = null;
        gap = '';
    };
    for (const r of p.runs) {
        if (r.b) {
            if (openBold && HEADING_GAP.test(gap)) { openBold.end = pos + r.text.length; openBold.text += gap + r.text; }
            else {
                if (openBold) finish();
                openBold = { start: pos, end: pos + r.text.length, text: r.text };
            }
            gap = '';
        } else if (openBold) {
            gap += r.text;
            if (!HEADING_GAP_PREFIX.test(gap)) finish();
        }
        pos += r.text.length;
    }
    if (openBold) finish();
    return bolds;
};

/**
 * Finds where `phrase` ("give up") is defined inside a flattened entry: the
 * bold run that reads as its heading — the phrase itself, with an object
 * placeholder, a bracketed option or alternative, stress marks ("give sth
 * up", "have (got) it made", "ˌgive ˈup") — compared word by word, so the
 * phrase need not occur verbatim. Returns { paraIndex, start, end,
 * heading:true } for a heading, or — when `allowLoose` — the first bold,
 * then the first plain occurrence with heading:false. Null when absent.
 */
export const findPhrase = (flat, phrase, { allowLoose = false } = {}) => {
    const needle = normalizeSpace(normalizeForSearch(phrase).norm);
    if (!needle) return null;
    const paragraphs = flat.paragraphs;
    for (let pi = 0; pi < paragraphs.length; pi++) {
        const p = paragraphs[pi];
        if (p.kind === 'hr') continue;
        for (const bold of boldRuns(p)) {
            if (headingMatches(bold.text, needle)) return { paraIndex: pi, start: bold.start, end: bold.end, heading: true };
        }
    }
    if (!allowLoose) return null;
    let firstBold = null;
    let firstAny = null;
    for (let pi = 0; pi < paragraphs.length; pi++) {
        const p = paragraphs[pi];
        if (p.kind === 'hr') continue;
        const bolds = boldRuns(p);
        const text = paragraphText(p);
        const { norm, map } = normalizeForSearch(text);
        let at = norm.indexOf(needle);
        while (at >= 0) {
            const endN = at + needle.length;
            if (!isWordChar(norm[at - 1]) && !isWordChar(norm[endN])) {
                const start = map[at];
                const end = map[endN];
                const hit = { paraIndex: pi, start, end, heading: false };
                if (!firstBold && bolds.some(b => b.start <= start && end <= b.end)) firstBold = hit;
                if (!firstAny) firstAny = hit;
            }
            at = norm.indexOf(needle, at + 1);
        }
    }
    return firstBold || firstAny;
};

// Does a heading, as words, occur across the context? Each heading word must
// match a context word in one of its forms (`formsOf`: the word and its
// inflections, either side), in order; a placeholder in the heading ("sth",
// "your") is free; in a heading of three words or more one context word may
// sit between two heading words ("make ends meet" in "made both ends meet");
// the tapped word must be among the matched ones — a heading elsewhere in
// the sentence is not what was tapped — and so must two content words:
// "the house" is no heading of house, nor "the run of something" of "ran
// out of".
const headingInContext = (words, forms, tappedIndex, formsOf) => {
    const n = forms.length;
    const matches = (hw, j) => j < n && formsOf(hw).some(f => forms[j].has(f));
    const gapAllowed = words.length >= 3;
    for (let start = 0; start < n; start++) {
        let i = start;
        let tapped = false;
        let content = 0;
        let ok = true;
        for (let h = 0; h < words.length && ok; h++) {
            const hw = words[h];
            let at = -1;
            if (matches(hw, i)) at = i;
            else if (PLACEHOLDERS.has(hw)) continue;
            else if (gapAllowed && h > 0 && matches(hw, i + 1)) at = i + 1;
            if (at < 0) { ok = false; break; }
            tapped = tapped || at === tappedIndex;
            if (!PLACEHOLDERS.has(hw) && !FUNCTION_WORDS.has(hw)) content++;
            i = at + 1;
        }
        if (ok && tapped && content >= 2) return true;
    }
    return false;
};

/**
 * The pen (revision 2.21) reaches an idiom by matching the scanned phrase
 * against the keys; a tap has a word and its sentence instead, so this goes
 * the other way: which bold heading of the entry — an idiom under its
 * keyword, a phrasal verb under its verb — occurs in the words around the
 * tap? The longest matching heading wins. `formsOf(word)` lists the forms a
 * word may take (itself and its base forms). Returns
 * { paraIndex, start, end, heading:true, phrase } or null.
 */
export const findHeadingInContext = (flat, contextWords, tappedIndex, formsOf) => {
    if (!contextWords || contextWords.length < 2) return null;
    const forms = contextWords.map(w => new Set(formsOf(w)));
    let best = null;
    const paragraphs = flat.paragraphs;
    for (let pi = 0; pi < paragraphs.length; pi++) {
        const p = paragraphs[pi];
        if (p.kind === 'hr') continue;
        for (const bold of boldRuns(p)) {
            for (const reading of headingVariants(bold.text)) {
                const words = reading.split(' ').filter(Boolean);
                if (words.length < 2 || (best && words.length <= best.words.length)) continue;
                if (!headingInContext(words, forms, tappedIndex, formsOf)) continue;
                best = { paraIndex: pi, start: bold.start, end: bold.end, words };
            }
        }
    }
    if (!best) return null;
    const { words, ...hit } = best;
    return { ...hit, heading: true, phrase: words.join(' ') };
};
