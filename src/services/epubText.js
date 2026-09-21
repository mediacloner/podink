/**
 * epubText — the text of an EPUB, section by section, for the audiobook
 * import (4.8.0): the book's own words stand in for a transcript of the
 * narration (bookMap.js / bookService.js).
 *
 * Pure JS over `readText(path) → string | null` (zipReader on the phone, the
 * file system in the Node tests). The OPF names the spine (reading order)
 * and the table of contents (toc.ncx, or the EPUB 3 nav document); each TOC
 * entry becomes a section made of the spine documents it points at, up to
 * the next entry. A document no entry names joins the section before it.
 * Several entries inside one document split it at their fragment ids.
 *
 * The XHTML is flattened with regular expressions rather than a DOM:
 * block-level tags become paragraph breaks, headings are flagged, every
 * other tag is dropped, entities are decoded. That is all the transcript
 * needs — words in reading order, grouped into paragraphs.
 */

const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: String.fromCharCode(160), shy: '',
    mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„',
    copy: '©', reg: '®', trade: '™', middot: '·', bull: '•', deg: '°', laquo: '«', raquo: '»', para: '¶', sect: '§',
    eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', aacute: 'á', acirc: 'â', iacute: 'í', oacute: 'ó', ocirc: 'ô',
    uacute: 'ú', ntilde: 'ñ', ccedil: 'ç', ouml: 'ö', uuml: 'ü', auml: 'ä', iuml: 'ï', euml: 'ë', szlig: 'ß',
    Eacute: 'É', Agrave: 'À', Ccedil: 'Ç', Ntilde: 'Ñ', Ouml: 'Ö', Uuml: 'Ü', Auml: 'Ä',
    frac12: '½', frac14: '¼', frac34: '¾', times: '×', divide: '÷', plusmn: '±', euro: '€', pound: '£', yen: '¥', cent: '¢',
};

/** `&amp;`, `&#8217;`, `&#x2019;`, `&rsquo;` → the character. Unknown names stay as written. */
export const decodeEntities = (s) => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-zA-Z]+\d*);/gi, (m, e) => {
    if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
        try { return String.fromCodePoint(code); } catch (_) { return m; }
    }
    const v = NAMED_ENTITIES[e] ?? NAMED_ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
});

// Tags that end a line of text. `body`/`html` are here so a bare text node
// straight under <body> still becomes a paragraph.
const BLOCK_TAGS = 'p|div|h[1-6]|li|ul|ol|blockquote|section|article|aside|header|footer|figure|figcaption|table|tbody|thead|tr|td|th|dt|dd|dl|pre|hr|br|nav|title|body|html|address|center';
const BLOCK_RE = new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi');
const HEADING_MARK = String.fromCharCode(1);

/**
 * XHTML → [{ text, heading }] in document order; empty lines dropped,
 * whitespace collapsed. `heading` is true for h1–h6 content.
 */
export const htmlToParagraphs = (html) => {
    let s = String(html || '');
    const bodyAt = s.search(/<body\b/i);
    if (bodyAt >= 0) s = s.slice(bodyAt);
    s = s
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(script|style|head|svg|math)\b[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<h[1-6]\b[^>]*>/gi, `\n${HEADING_MARK}`)
        .replace(/<\/h[1-6]\s*>/gi, '\n')
        .replace(BLOCK_RE, '\n')
        .replace(/<[^>]+>/g, '');
    s = decodeEntities(s);
    const out = [];
    for (const raw of s.split('\n')) {
        let heading = false;
        let line = raw;
        if (line.indexOf(HEADING_MARK) >= 0) {
            heading = true;
            line = line.split(HEADING_MARK).join('');
        }
        const text = line
            .replace(/\s+/g, ' ')
            // "Gran-Gran . . . she would tell me to fight." — a spaced
            // ellipsis is one mark. Left as three lone stops it becomes three
            // sentences, and the reader shows each on a line of its own.
            .replace(/(?:\.\s){2,}\./g, '…')
            .replace(/\s+…/g, '…')
            .trim();
        if (text) out.push({ text, heading });
    }
    return out;
};

// ─── OPF / NCX / nav parsing ────────────────────────────────────────────────

const dirname = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };

/** `href` relative to `base` (a directory inside the archive) → archive path, fragment dropped. */
export const resolvePath = (base, href) => {
    let clean = String(href || '').split('#')[0];
    try { clean = decodeURIComponent(clean); } catch (_) { /* keep the raw href */ }
    if (clean.startsWith('/')) return clean.slice(1);
    const parts = (base ? base.split('/') : []).concat(clean.split('/'));
    const out = [];
    for (const part of parts) {
        if (part === '..') out.pop();
        else if (part !== '.' && part !== '') out.push(part);
    }
    return out.join('/');
};

const attrsOf = (tag) => {
    const o = {};
    const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(tag))) o[m[1].toLowerCase()] = decodeEntities(m[2] !== undefined ? m[2] : m[3]);
    return o;
};
const tagsNamed = (xml, name) => {
    const re = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>`, 'gi');
    const out = [];
    let m;
    while ((m = re.exec(xml))) out.push(m[0]);
    return out;
};
const textOf = (xml, name) => {
    const m = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}\\s*>`, 'i').exec(xml);
    return m ? decodeEntities(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() : '';
};

/** toc.ncx → [{ title, path, fragment }] in document order (nesting flattened). */
export const parseNcx = (ncx, ncxDir) => {
    const out = [];
    const re = /<navPoint\b[^>]*>([\s\S]*?)(?=<navPoint\b|<\/navPoint>)/gi;
    let m;
    while ((m = re.exec(ncx))) {
        const body = m[1];
        const label = textOf(body, 'text');
        const src = /<content\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(body);
        const href = src ? (src[1] !== undefined ? src[1] : src[2]) : null;
        if (href) out.push({ title: label, path: resolvePath(ncxDir, href), fragment: href.split('#')[1] || '' });
    }
    return out;
};

/** EPUB 3 nav document → the same shape, from its `epub:type="toc"` list (or every link). */
export const parseNav = (nav, navDir) => {
    const toc = /<nav\b[^>]*epub:type\s*=\s*["'][^"']*\btoc\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i.exec(nav);
    const scope = toc ? toc[1] : nav;
    const out = [];
    const re = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(scope))) {
        const href = m[1] !== undefined ? m[1] : m[2];
        const title = decodeEntities(m[3].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
        out.push({ title, path: resolvePath(navDir, href), fragment: href.split('#')[1] || '' });
    }
    return out;
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const countWords = (paragraphs) => paragraphs.reduce((n, p) => n + (p.text ? p.text.split(' ').length : 0), 0);

/**
 * The whole book: `{ title, author, language, sections: [{ title, paths,
 * paragraphs: [{ text, heading }], words }] }`. Sections follow the table
 * of contents; the spine's reading order decides what each one contains.
 */
export const readEpub = async (readText) => {
    const container = (await readText('META-INF/container.xml')) || '';
    const rootfile = /<rootfile\b[^>]*\bfull-path\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(container);
    const opfPath = rootfile ? (rootfile[1] || rootfile[2]) : 'content.opf';
    const opfDir = dirname(opfPath);
    const opf = await readText(opfPath);
    if (!opf) throw new Error('The EPUB has no package document');

    const manifest = {};
    for (const t of tagsNamed(opf, 'item')) {
        const a = attrsOf(t);
        if (a.id && a.href) manifest[a.id] = { ...a, path: resolvePath(opfDir, a.href) };
    }
    const spineTag = tagsNamed(opf, 'spine')[0] || '';
    const spineAttrs = attrsOf(spineTag);
    const spine = tagsNamed(opf, 'itemref').map(attrsOf)
        .filter((a) => a.idref && manifest[a.idref] && a.linear !== 'no')
        .map((a) => manifest[a.idref].path);

    const title = textOf(opf, 'title');
    const author = textOf(opf, 'creator');
    const language = textOf(opf, 'language');

    let toc = [];
    const ncxItem = manifest[spineAttrs.toc]
        || Object.values(manifest).find((it) => it['media-type'] === 'application/x-dtbncx+xml');
    const navItem = Object.values(manifest).find((it) => /(^|\s)nav(\s|$)/.test(it.properties || ''));
    if (ncxItem) toc = parseNcx((await readText(ncxItem.path)) || '', dirname(ncxItem.path));
    if (!toc.length && navItem) toc = parseNav((await readText(navItem.path)) || '', dirname(navItem.path));

    const entriesByPath = new Map();
    for (const e of toc) {
        if (!entriesByPath.has(e.path)) entriesByPath.set(e.path, []);
        entriesByPath.get(e.path).push(e);
    }

    const sections = [];
    const push = (sectionTitle, path, paragraphs) => sections.push({ title: sectionTitle || '', paths: [path], paragraphs });
    for (const path of spine) {
        const html = await readText(path);
        if (html == null) continue;
        const entries = entriesByPath.get(path) || [];
        if (!entries.length) {
            const paras = htmlToParagraphs(html);
            if (sections.length) {
                const last = sections[sections.length - 1];
                last.paths.push(path);
                last.paragraphs.push(...paras);
            } else {
                push('', path, paras);
            }
            continue;
        }
        const withFragments = entries.filter((e) => e.fragment);
        if (entries.length === 1 || withFragments.length < entries.length - 1) {
            push(entries[0].title, path, htmlToParagraphs(html));
            continue;
        }
        // Several entries inside one document: cut the markup where each id sits.
        let rest = html;
        let currentTitle = entries[0].title;
        const pieces = [];
        for (let i = 1; i < entries.length; i++) {
            const id = entries[i].fragment;
            if (!id) continue;
            const at = rest.search(new RegExp(`<[^>]+\\bid\\s*=\\s*["']${escapeRe(id)}["']`));
            if (at < 0) continue;
            pieces.push({ title: currentTitle, html: rest.slice(0, at) });
            rest = rest.slice(at);
            currentTitle = entries[i].title;
        }
        pieces.push({ title: currentTitle, html: rest });
        pieces.forEach((piece, i) => push(piece.title, path, htmlToParagraphs(i === 0 ? piece.html : `<body>${piece.html}`)));
    }
    for (const s of sections) s.words = countWords(s.paragraphs);
    return { title, author, language, sections };
};
