/**
 * showNotes.js — turns an episode's show notes into blocks the ShowNotes
 * component can lay out.
 *
 * A podcast's <description> / <content:encoded> arrives as whatever HTML the
 * host produced: <p> paragraphs, <br><br> paragraphs, bare text with blank
 * lines, <ul> chapter lists, <h2> section titles, <a> links, entities
 * (&amp;, &#8217;), <img> tracking pixels. Stripping the tags — what the
 * rows did before — welds all of that into one grey slab. This module keeps
 * the structure the author gave it and drops the rest:
 *
 *   [{ kind: 'p' | 'h' | 'li', depth, ordinal, runs: [{ text, bold, italic, link }] }]
 *
 *   - block tags and <br><br> / blank lines start a new paragraph; a single
 *     <br> (or newline in plain text) is a line break inside it
 *   - <h1>–<h6> become headings; <li> items carry a bullet or, in an <ol>,
 *     their number; nested lists indent
 *   - <b>/<strong>, <i>/<em> and <a href> survive as run flags; bare
 *     http(s):// and www. URLs in the text are made tappable too
 *   - "- item" / "1. item" lines in plain-text notes become list items
 *
 * The HTML parser and entity table are the dictionary card's
 * (dictionaryHtml.js) — same tolerance for unclosed tags and stray closers.
 * Pure module — no React, no native imports.
 */

import { decodeEntities, parseHtml } from './dictionaryHtml';

const BLOCK_TAGS = new Set([
    'p', 'div', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'tbody', 'thead',
    'tfoot', 'tr', 'section', 'article', 'header', 'footer', 'pre', 'dl', 'dt', 'dd', 'figure', 'figcaption',
    'center', 'address', 'aside', 'main', 'nav', 'summary', 'details',
]);
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const BOLD_TAGS = new Set(['b', 'strong', 'th', 'dt']);
const ITALIC_TAGS = new Set(['i', 'em', 'cite', 'dfn', 'q']);
// Dropped with their content. (<img> is a void tag — the parser already
// skips it; listed for clarity.)
const SKIP_TAGS = new Set([
    'script', 'style', 'img', 'video', 'audio', 'iframe', 'object', 'embed', 'svg', 'head', 'title', 'button',
    'input', 'select', 'textarea', 'picture', 'source', 'track', 'noscript', 'form',
]);

// Something that tells us the text is HTML with its own line structure; without
// one, the author's newlines are the only paragraph breaks there are.
const STRUCTURED_HTML_RE = /<(p|div|li|h[1-6]|br|tr|blockquote|ul|ol|table|pre|section|article)\b/i;
const ANY_TAG_RE = /<\s*\/?[a-zA-Z][^>]*>/;

// Bare URLs to make tappable. Trailing punctuation that usually ends a
// sentence, not the URL, is left out of the match.
const URL_RE = /((?:https?:\/\/|www\.)[^\s<>"'“”‘’()[\]{}]+?)(?=[.,;:!?…]*(?:\s|$|[)\]}"'“”‘’]))/gi;

const BULLET_LINE_RE = /^[-*•·▪◦]\s+/;
const ORDERED_LINE_RE = /^(\d{1,3})[.)]\s+/;

export const blockText = (block) => (block?.runs || []).map(r => r.text).join('');

const cleanHref = (raw) => {
    const href = decodeEntities(String(raw || '')).trim();
    if (!href) return null;
    if (/^(https?:\/\/|mailto:)/i.test(href)) return href;
    if (/^www\./i.test(href)) return `https://${href}`;
    return null;
};

// A line that is a list item: "- item", "• item", "3. item", "3) item".
const LIST_LINE = String.raw`[ \t]*(?:[-*•·▪◦]|\d{1,3}[.)])[ \t]+`;
const BEFORE_LIST_LINE_RE = new RegExp(String.raw`\n(?=${LIST_LINE}\S)`, 'g');
const AFTER_LIST_LINE_RE = new RegExp(String.raw`^(${LIST_LINE}[^\n]*)\n(?!${LIST_LINE}\S)`, 'gm');

/** Plain text (or HTML without block tags): newlines are the structure. */
const preformat = (src) => {
    if (STRUCTURED_HTML_RE.test(src)) return src;
    return src
        .replace(/\r\n?/g, '\n')
        // Each list line stands alone, so the post-pass can make it an item.
        .replace(BEFORE_LIST_LINE_RE, '\n\n')
        .replace(AFTER_LIST_LINE_RE, '$1\n\n')
        .replace(/\n[ \t]*\n(?:[ \t]*\n)*/g, '<br><br>')
        .replace(/\n/g, '<br>');
};

/**
 * @param {string} input  HTML or plain text.
 * @returns {Array<{kind:'p'|'h'|'li', depth:number, ordinal:number, runs:Array}>}
 */
export const showNotesToBlocks = (input) => {
    const src = String(input || '').trim();
    if (!src) return [];
    // Feeds that escape their HTML twice ("&lt;p&gt;") arrive as text; one
    // decode pass turns them back into markup before parsing.
    const unescaped = !ANY_TAG_RE.test(src) && /&lt;\s*[a-zA-Z]/.test(src) ? decodeEntities(src) : src;
    const root = parseHtml(preformat(unescaped));

    const blocks = [];
    const lists = [];            // stack of { ordered, count } for <ul>/<ol>
    let cur = null;              // block being filled
    let li = null;               // { ordinal, fresh } while inside an <li>
    let heading = 0;             // > 0 while inside an <h*>
    let pendingSpace = false;
    let pendingBreak = false;

    const open = () => {
        if (cur) return cur;
        let kind = 'p';
        let ordinal = 0;
        let depth = lists.length;
        if (heading > 0) {
            kind = 'h';
        } else if (li && li.fresh) {
            kind = 'li';
            ordinal = li.ordinal;
            depth = Math.max(0, lists.length - 1);
            li.fresh = false;
        }
        cur = { kind, depth, ordinal, runs: [] };
        pendingSpace = false;
        pendingBreak = false;
        return cur;
    };

    const close = () => {
        if (!cur) return;
        while (cur.runs.length) {
            const last = cur.runs[cur.runs.length - 1];
            last.text = last.text.replace(/[\s\n]+$/, '');
            if (last.text) break;
            cur.runs.pop();
        }
        if (cur.runs.length) blocks.push(cur);
        cur = null;
        pendingSpace = false;
        pendingBreak = false;
    };

    const pushRun = (block, text, st) => {
        if (!text) return;
        const prev = block.runs[block.runs.length - 1];
        if (prev && !!prev.bold === !!st.bold && !!prev.italic === !!st.italic && (prev.link || null) === (st.link || null)) {
            prev.text += text;
            return;
        }
        block.runs.push({ text, bold: !!st.bold, italic: !!st.italic, link: st.link || null });
    };

    // Text outside an <a> gets its bare URLs turned into link runs.
    const pushLinkified = (block, text, st) => {
        if (st.link) { pushRun(block, text, st); return; }
        let last = 0;
        URL_RE.lastIndex = 0;
        let m;
        while ((m = URL_RE.exec(text))) {
            if (m.index > last) pushRun(block, text.slice(last, m.index), st);
            const url = m[1];
            pushRun(block, url, { ...st, link: /^www\./i.test(url) ? `https://${url}` : url });
            last = m.index + url.length;
        }
        if (last < text.length) pushRun(block, text.slice(last), st);
    };

    const pushText = (raw, st) => {
        let text = decodeEntities(raw).replace(/[\s\u00a0]+/g, ' ');
        if (!text) return;
        if (text === ' ') {
            if (cur && cur.runs.length) pendingSpace = true;
            return;
        }
        const block = open();
        const first = block.runs.length === 0;
        if (pendingBreak) {
            text = `\n${text.replace(/^ /, '')}`;
        } else if (pendingSpace && !text.startsWith(' ')) {
            text = ` ${text}`;
        }
        pendingBreak = false;
        pendingSpace = false;
        if (first) text = text.replace(/^[ \n]+/, '');
        pushLinkified(block, text, st);
    };

    const walk = (node, st) => {
        if (node.type === 'text') { pushText(node.text, st); return; }
        const tag = node.tag;
        if (SKIP_TAGS.has(tag)) return;
        if (tag === 'br') {
            // One <br> is a line break; a second one in a row is a paragraph.
            if (!cur || !cur.runs.length) return;
            if (pendingBreak) close(); else pendingBreak = true;
            return;
        }
        if (tag === 'hr') { close(); return; }

        const isBlock = BLOCK_TAGS.has(tag);
        if (isBlock) close();

        let next = st;
        if (BOLD_TAGS.has(tag)) next = { ...next, bold: true };
        if (ITALIC_TAGS.has(tag)) next = { ...next, italic: true };
        if (tag === 'a') {
            const href = cleanHref(node.attrs.href);
            if (href) next = { ...next, link: href };
        }
        if (tag === 'ul' || tag === 'ol') lists.push({ ordered: tag === 'ol', count: 0 });
        let prevLi = null;
        if (tag === 'li') {
            const list = lists[lists.length - 1];
            if (list) list.count += 1;
            prevLi = li;
            li = { ordinal: list && list.ordered ? list.count : 0, fresh: true };
        }
        if (HEADING_TAGS.has(tag)) heading += 1;

        for (const child of node.children) walk(child, next);

        if (isBlock) close();
        if (HEADING_TAGS.has(tag)) heading -= 1;
        if (tag === 'li') li = prevLi;
        if (tag === 'ul' || tag === 'ol') lists.pop();
    };

    walk(root, {});
    close();

    // Plain-text lists: "- item" / "1. item" lines were paragraphs so far.
    for (const b of blocks) {
        if (b.kind !== 'p' || !b.runs.length) continue;
        const head = b.runs[0].text;
        let m;
        if ((m = ORDERED_LINE_RE.exec(head))) {
            b.kind = 'li';
            b.ordinal = parseInt(m[1], 10);
            b.runs[0].text = head.slice(m[0].length);
        } else if (BULLET_LINE_RE.test(head)) {
            b.kind = 'li';
            b.runs[0].text = head.replace(BULLET_LINE_RE, '');
        }
        if (!b.runs[0].text) b.runs.shift();
    }
    return blocks.filter(b => b.runs.length);
};

/**
 * One-line summary for a row or card: the notes' text with the structure
 * folded into spaces, cut at `maxLen` on a word boundary with an ellipsis.
 */
export const showNotesPlainText = (input, maxLen = 0) => {
    const text = showNotesToBlocks(input)
        .map(blockText)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (maxLen > 0 && text.length > maxLen) {
        const cut = text.slice(0, maxLen);
        const sp = cut.lastIndexOf(' ');
        return `${(sp > maxLen * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.!?…-]+$/, '')}…`;
    }
    return text;
};
