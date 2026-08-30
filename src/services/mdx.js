/**
 * mdx.js — random-access reader for MDict `.mdx` dictionaries (engine
 * version 2.0, zlib or stored blocks, plain or `Encrypted="2"` — which is
 * what every dictionary in the penReader set is).
 *
 * The file is never loaded whole. Opening parses the header, the key-block
 * index and the record-block index (a few hundred KB at most); a lookup
 * then inflates only the key blocks that can hold the word and the one
 * record block that holds the entry, so a 24 MB dictionary answers in a
 * few tens of milliseconds from disk.
 *
 * Key order inside these files is NOT plain lower-case order (the builder
 * sorted on a punctuation-stripped form, and several files break even that
 * on accents), so the file's own first/last keys can't drive a binary
 * search. Instead `buildBlockIndex` walks every key block once after
 * installation and records the true min/max of each block under `foldKey`;
 * `findKeys` then inflates just the blocks whose range covers the folded
 * word — usually one to four of them.
 *
 * Pure JS: the file is reached through a tiny `reader` object
 * ({ size, read(offset, length) → Uint8Array }) so the same code runs on
 * an expo-file-system FileHandle in the app and on `fs` in Node tests.
 */
import pako from 'pako';

// ── Byte helpers ─────────────────────────────────────────────────────────────

const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
// Sizes and offsets are 64-bit in the format but far below 2^53 in practice.
const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
const u32le = (b, o) => b[o] + (b[o + 1] << 8) + (b[o + 2] << 16) + ((b[o + 3] << 24) >>> 0);

const hasTextDecoder = typeof TextDecoder !== 'undefined';
const utf8Decoder = hasTextDecoder ? new TextDecoder('utf-8') : null;

/** UTF-8 → string for a byte range. Uses TextDecoder when the runtime has one. */
export const utf8Decode = (bytes, start = 0, end = bytes.length) => {
    if (utf8Decoder) return utf8Decoder.decode(bytes.subarray(start, end));
    let out = '';
    let i = start;
    // ASCII fast path in slices (fromCharCode.apply has an argument cap).
    while (i < end) {
        const sliceEnd = Math.min(end, i + 8192);
        let ascii = true;
        for (let j = i; j < sliceEnd; j++) if (bytes[j] > 0x7f) { ascii = false; break; }
        if (ascii) {
            out += String.fromCharCode.apply(null, bytes.subarray(i, sliceEnd));
            i = sliceEnd;
            continue;
        }
        const codes = [];
        while (i < sliceEnd) {
            const c = bytes[i++];
            if (c < 0x80) { codes.push(c); continue; }
            if (c < 0xe0) { codes.push(((c & 0x1f) << 6) | (bytes[i++] & 0x3f)); continue; }
            if (c < 0xf0) {
                codes.push(((c & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
                continue;
            }
            let cp = ((c & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
            cp -= 0x10000;
            codes.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        }
        out += String.fromCharCode.apply(null, codes);
    }
    return out;
};

const utf16leDecode = (bytes) => {
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) {
        const c = bytes[i] | (bytes[i + 1] << 8);
        if (c === 0) break;
        out += String.fromCharCode(c);
    }
    return out;
};

// ── Key folding ──────────────────────────────────────────────────────────────

const NON_ASCII = /[^\x00-\x7f]/;
const COMBINING = /[\u0300-\u036f]/g;
const NON_ALNUM = /[^\p{L}\p{N}]+/gu;

/**
 * The comparison form of a key: lower-case, accents stripped, everything
 * that isn't a letter or digit removed — so "e-mail", "E–mail" and "email"
 * meet, "café" answers "cafe", and "give up" is "giveup". Used both to sort
 * the block index and to match a looked-up word.
 */
export const foldKey = (s) => {
    let t = String(s ?? '');
    if (NON_ASCII.test(t)) {
        try { t = t.normalize('NFD').replace(COMBINING, ''); } catch (_) { /* no ICU: keep as is */ }
    }
    return t.toLowerCase().replace(NON_ALNUM, '');
};

// ── Block decompression ──────────────────────────────────────────────────────

const COMP_NONE = 0;
const COMP_LZO = 1;
const COMP_ZLIB = 2;

/** Inflates one whole block (4-byte type + 4-byte adler32 + payload). */
const inflateBlock = (bytes) => {
    const type = u32le(bytes, 0);
    const payload = bytes.subarray(8);
    if (type === COMP_NONE) return payload;
    if (type === COMP_ZLIB) return pako.inflate(payload);
    if (type === COMP_LZO) throw new Error('LZO-compressed MDX is not supported');
    throw new Error(`Unknown MDX block compression ${type}`);
};

// ── The Encrypted="2" key index ──────────────────────────────────────────────
// Not real encryption: MDict scrambles the key-index block with a fixed,
// keyless scheme (LDOCE 6 and Vocabulary.com ship this way) — RIPEMD-128 of
// the block's own checksum salted with 0x3695 keys a byte shuffle. Record
// blocks stay plain; only Encrypted="1" (a real user key) is rejected.

const RMD_RL = [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
    3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12,
    1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2,
];
const RMD_RR = [
    5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12,
    6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
    15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13,
    8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
];
const RMD_SL = [
    11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8,
    7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
    11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5,
    11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
];
const RMD_SR = [
    8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6,
    9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
    9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5,
    15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
];
const RMD_KL = [0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc];
const RMD_KR = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x00000000];

const rol = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
const rmdF = (j, x, y, z) =>
    j < 16 ? (x ^ y ^ z) >>> 0 :
    j < 32 ? ((x & y) | (~x & z)) >>> 0 :
    j < 48 ? ((x | ~y) ^ z) >>> 0 :
             ((x & z) | (y & ~z)) >>> 0;

export const ripemd128 = (bytes) => {
    const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const bitLen = bytes.length * 8;
    const hi = Math.floor(bytes.length / 0x20000000);
    for (let i = 0; i < 4; i++) {
        padded[padded.length - 8 + i] = (bitLen >>> (i * 8)) & 0xff;
        padded[padded.length - 4 + i] = (hi >>> (i * 8)) & 0xff;
    }
    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476;
    const X = new Array(16);
    for (let off = 0; off < padded.length; off += 64) {
        for (let i = 0; i < 16; i++) X[i] = u32le(padded, off + i * 4);
        let al = h0, bl = h1, cl = h2, dl = h3;
        let ar = h0, br = h1, cr = h2, dr = h3;
        for (let j = 0; j < 64; j++) {
            const round = j >> 4;
            let t = rol((al + rmdF(j, bl, cl, dl) + X[RMD_RL[j]] + RMD_KL[round]) >>> 0, RMD_SL[j]);
            al = dl; dl = cl; cl = bl; bl = t;
            t = rol((ar + rmdF(63 - j, br, cr, dr) + X[RMD_RR[j]] + RMD_KR[round]) >>> 0, RMD_SR[j]);
            ar = dr; dr = cr; cr = br; br = t;
        }
        const t = (h1 + cl + dr) >>> 0;
        h1 = (h2 + dl + ar) >>> 0;
        h2 = (h3 + al + br) >>> 0;
        h3 = (h0 + bl + cr) >>> 0;
        h0 = t;
    }
    const out = new Uint8Array(16);
    [h0, h1, h2, h3].forEach((h, i) => {
        out[i * 4] = h & 0xff; out[i * 4 + 1] = (h >>> 8) & 0xff;
        out[i * 4 + 2] = (h >>> 16) & 0xff; out[i * 4 + 3] = (h >>> 24) & 0xff;
    });
    return out;
};

/** Undoes the Encrypted="2" scramble of the key-index block, in place. */
const descrambleKeyIndex = (block) => {
    const key = ripemd128(Uint8Array.from([...block.subarray(4, 8), 0x95, 0x36, 0x00, 0x00]));
    let prev = 0x36;
    for (let i = 8; i < block.length; i++) {
        const b = block[i];
        block[i] = (((b >>> 4) | (b << 4)) ^ prev ^ ((i - 8) & 0xff) ^ key[(i - 8) & 15]) & 0xff;
        prev = b;
    }
    return block;
};

const concatChunks = (chunks, total) => {
    if (chunks.length === 1) return chunks[0];
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
};

// Compressed bytes are fed to the inflater in slices this big, so a record
// near the start of a huge block (one Oxford block inflates to 60 MB) costs
// only the slices up to it.
const INFLATE_SLICE = 256 * 1024;
// No real entry is this long; the one that is (Oxford Advanced's last key
// swallowed the rest of the book, 60 MB) is cut here rather than rendered.
// LDOCE 6 has records up to ~2.6 MB (`do`) — mostly popup blocks that the
// ldoce style strips before rendering, but they must survive the read.
const MAX_RECORD_BYTES = 4 * 1024 * 1024;

// ── Reader ───────────────────────────────────────────────────────────────────

const KEY_BLOCK_CACHE = 12;

export class MdxFile {
    constructor(reader) {
        this.reader = reader;
        this.attrs = {};
        this.encoding = 'UTF-8';
        this.utf16 = false;
        this.keyBlocks = [];      // { n, first, last, csz, dsz, coff }
        this.recordBlocks = [];   // { csz, dsz, coff, doff }
        this.numEntries = 0;
        this.blockIndex = null;   // [[min, max], ...] under foldKey, per key block
        this._keyCache = new Map(); // block index → { entries, folds }
    }

    /** Parses the header and both block indexes. Throws on unsupported files. */
    static open(reader, blockIndex = null) {
        const m = new MdxFile(reader);
        m._parse();
        m.blockIndex = blockIndex;
        return m;
    }

    get title() { return this.attrs.Title || ''; }

    _read(offset, length) {
        if (length <= 0) return new Uint8Array(0);
        return this.reader.read(offset, length);
    }

    _parse() {
        const r = this.reader;
        const headerLen = u32(this._read(0, 4), 0);
        const header = utf16leDecode(this._read(4, headerLen));
        const attrs = {};
        const re = /([\w:]+)="([^"]*)"/g;
        let m;
        while ((m = re.exec(header))) attrs[m[1]] = m[2];
        this.attrs = attrs;
        const version = parseFloat(attrs.GeneratedByEngineVersion || '2.0');
        if (!(version >= 2)) throw new Error(`MDX engine version ${attrs.GeneratedByEngineVersion} is not supported (need 2.x)`);
        const encrypted = parseInt(attrs.Encrypted || '0', 10) || (attrs.Encrypted === 'Yes' ? 3 : 0);
        if (encrypted & 1) throw new Error('MDX with key-encrypted record blocks is not supported');
        this.encoding = (attrs.Encoding || 'UTF-8').toUpperCase();
        this.utf16 = this.encoding.startsWith('UTF-16');

        let pos = 4 + headerLen + 4; // header + adler32
        // Key section header: 5 × u64 + adler32.
        const kh = this._read(pos, 44);
        pos += 44;
        const numKeyBlocks = u64(kh, 0);
        this.numEntries = u64(kh, 8);
        const keyIndexCompLen = u64(kh, 24);
        const keyBlocksLen = u64(kh, 32);

        const keyIndexRaw = this._read(pos, keyIndexCompLen);
        const keyIndex = inflateBlock((encrypted & 2) ? descrambleKeyIndex(keyIndexRaw) : keyIndexRaw);
        pos += keyIndexCompLen;
        const keyBlocksStart = pos;
        const unit = this.utf16 ? 2 : 1;
        const blocks = [];
        let o = 0;
        let coff = keyBlocksStart;
        for (let i = 0; i < numKeyBlocks; i++) {
            const n = u64(keyIndex, o); o += 8;
            let l = u16(keyIndex, o); o += 2;
            const first = this._decodeKey(keyIndex, o, o + l * unit); o += (l + 1) * unit;
            l = u16(keyIndex, o); o += 2;
            const last = this._decodeKey(keyIndex, o, o + l * unit); o += (l + 1) * unit;
            const csz = u64(keyIndex, o); o += 8;
            const dsz = u64(keyIndex, o); o += 8;
            blocks.push({ n, first, last, csz, dsz, coff });
            coff += csz;
        }
        this.keyBlocks = blocks;
        pos += keyBlocksLen;

        // Record section header: 4 × u64.
        const rh = this._read(pos, 32);
        pos += 32;
        const numRecordBlocks = u64(rh, 0);
        const recordIndexLen = u64(rh, 16);
        const recordIndex = this._read(pos, recordIndexLen);
        pos += recordIndexLen;
        const records = [];
        let rcoff = pos;
        let doff = 0;
        for (let i = 0; i < numRecordBlocks; i++) {
            const csz = u64(recordIndex, i * 16);
            const dsz = u64(recordIndex, i * 16 + 8);
            records.push({ csz, dsz, coff: rcoff, doff });
            rcoff += csz;
            doff += dsz;
        }
        this.recordBlocks = records;
        if (r.size != null && rcoff > r.size + 1) {
            throw new Error('MDX record section runs past the end of the file (truncated download?)');
        }
    }

    _decodeKey(bytes, start, end) {
        return this.utf16 ? utf16leDecode(bytes.subarray(start, end)) : utf8Decode(bytes, start, end);
    }

    /** All { key, off } entries of key block `i` (cached, most recent few). */
    readKeyBlock(i) {
        const cached = this._keyCache.get(i);
        if (cached) return cached;
        const blk = this.keyBlocks[i];
        const data = inflateBlock(this._read(blk.coff, blk.csz));
        const entries = new Array(blk.n);
        const folds = new Array(blk.n);
        let p = 0;
        for (let k = 0; k < blk.n; k++) {
            const off = u64(data, p); p += 8;
            let e = p;
            if (this.utf16) {
                while (e + 1 < data.length && (data[e] !== 0 || data[e + 1] !== 0)) e += 2;
            } else {
                while (e < data.length && data[e] !== 0) e++;
            }
            const key = this._decodeKey(data, p, e);
            p = e + (this.utf16 ? 2 : 1);
            entries[k] = { key, off };
            folds[k] = foldKey(key);
        }
        const value = { entries, folds };
        this._keyCache.set(i, value);
        if (this._keyCache.size > KEY_BLOCK_CACHE) {
            this._keyCache.delete(this._keyCache.keys().next().value);
        }
        return value;
    }

    /**
     * True min/max folded key of every key block. Walks the whole key
     * section once (the biggest dictionary here has 1.9 M keys in 1,163
     * blocks — a few seconds), yielding to the event loop every ~40 ms so
     * the UI keeps painting. `onProgress(done, total)`.
     */
    async buildBlockIndex(onProgress) {
        const total = this.keyBlocks.length;
        const index = new Array(total);
        let lastYield = Date.now();
        for (let i = 0; i < total; i++) {
            const { folds } = this.readKeyBlock(i);
            this._keyCache.delete(i); // don't churn the lookup cache while indexing
            let min = folds[0] ?? '';
            let max = min;
            for (let k = 1; k < folds.length; k++) {
                const f = folds[k];
                if (f < min) min = f;
                else if (f > max) max = f;
            }
            index[i] = [min, max];
            if (onProgress && (i % 8 === 0 || i === total - 1)) onProgress(i + 1, total);
            if (Date.now() - lastYield > 40) {
                await new Promise(resolve => setTimeout(resolve, 0));
                lastYield = Date.now();
            }
        }
        this.blockIndex = index;
        return index;
    }

    /** Key blocks whose folded range can contain `fold`. */
    _candidateBlocks(fold) {
        const idx = this.blockIndex;
        const out = [];
        if (idx) {
            for (let i = 0; i < idx.length; i++) {
                if (idx[i][0] <= fold && fold <= idx[i][1]) out.push(i);
            }
            return out;
        }
        // No index yet (should not happen after install): fall back to the
        // file's own first/last keys, widened by one block each side.
        const kb = this.keyBlocks;
        for (let i = 0; i < kb.length; i++) {
            const lo = foldKey(kb[i].first);
            const hi = foldKey(kb[i].last);
            if (lo <= fold && fold <= hi) {
                if (i > 0 && !out.includes(i - 1)) out.push(i - 1);
                out.push(i);
                if (i + 1 < kb.length) out.push(i + 1);
            }
        }
        return out;
    }

    /**
     * Every key whose folded form equals the folded `word`, in file order —
     * homographs and their `@@@LINK=` redirects are separate keys, so a
     * word routinely yields several. `[{ key, off }]`.
     */
    findKeys(word) {
        const fold = foldKey(word);
        if (!fold) return [];
        const hits = [];
        const seen = new Set();
        for (const i of this._candidateBlocks(fold)) {
            const { entries, folds } = this.readKeyBlock(i);
            for (let k = 0; k < folds.length; k++) {
                if (folds[k] === fold && !seen.has(entries[k].off)) {
                    seen.add(entries[k].off);
                    hits.push(entries[k]);
                }
            }
        }
        return hits;
    }

    /** True when at least one key folds to the same form as `word`. */
    hasKey(word) {
        return this.findKeys(word).length > 0;
    }

    /**
     * The record (HTML, or an `@@@LINK=` marker) stored at key offset `off`.
     * Inflates the containing record block incrementally and stops as soon
     * as the record's terminating NUL has appeared.
     */
    readRecord(off) {
        const blocks = this.recordBlocks;
        let lo = 0;
        let hi = blocks.length - 1;
        let j = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const b = blocks[mid];
            if (off < b.doff) hi = mid - 1;
            else if (off >= b.doff + b.dsz) lo = mid + 1;
            else { j = mid; break; }
        }
        if (j < 0) return '';
        const blk = blocks[j];
        const local = off - blk.doff;
        const head = this._read(blk.coff, 8);
        const type = u32le(head, 0);
        const payloadLen = blk.csz - 8;

        if (type === COMP_NONE) {
            // Stored: read from the record straight to the block end (records are
            // small next to the 64 KB blocks; bounded by the block anyway).
            const bytes = this._read(blk.coff + 8 + local, Math.min(payloadLen - local, blk.dsz - local));
            let e = 0;
            while (e < bytes.length && bytes[e] !== 0) e++;
            return this._decodeRecord(bytes, 0, e);
        }
        if (type !== COMP_ZLIB) throw new Error(`Unsupported record block compression ${type}`);

        const inflater = new pako.Inflate({ chunkSize: INFLATE_SLICE });
        const chunks = [];
        let outLen = 0;
        inflater.onData = (chunk) => { chunks.push(chunk); outLen += chunk.length; };
        let readSoFar = 0;
        let endAt = -1;
        let scanFrom = local;
        while (readSoFar < payloadLen) {
            const n = Math.min(INFLATE_SLICE, payloadLen - readSoFar);
            const slice = this._read(blk.coff + 8 + readSoFar, n);
            readSoFar += n;
            const last = readSoFar >= payloadLen;
            inflater.push(slice, last ? pako.constants.Z_FINISH : pako.constants.Z_SYNC_FLUSH);
            if (inflater.err) throw new Error(`Record block inflate failed: ${inflater.msg || inflater.err}`);
            if (outLen > local) {
                // Look for the record terminator in what has arrived since the last scan.
                let base = 0;
                for (const c of chunks) {
                    const cStart = base;
                    const cEnd = base + c.length;
                    if (cEnd > scanFrom) {
                        const from = Math.max(scanFrom, cStart) - cStart;
                        const at = c.indexOf(0, from);
                        if (at >= 0) { endAt = cStart + at; break; }
                    }
                    base = cEnd;
                }
                scanFrom = outLen;
                if (endAt >= 0) break;
                if (outLen - local > MAX_RECORD_BYTES) { endAt = local + MAX_RECORD_BYTES; break; }
            }
        }
        const data = concatChunks(chunks, outLen);
        const end = Math.min(endAt >= 0 ? endAt : outLen, local + MAX_RECORD_BYTES);
        return this._decodeRecord(data, local, end);
    }

    _decodeRecord(bytes, start, end) {
        const text = this.utf16 ? utf16leDecode(bytes.subarray(start, end)) : utf8Decode(bytes, start, end);
        return text.replace(/\0+$/, '');
    }
}

/** Reader over an expo-file-system `File` (opened per read; handles are cheap). */
export const fileReader = (file) => ({
    size: file.size,
    read(offset, length) {
        const handle = file.open();
        try {
            handle.offset = offset;
            return handle.readBytes(length);
        } finally {
            handle.close();
        }
    },
});
