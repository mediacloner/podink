/**
 * zipReader — the ZIP container an EPUB is, read from a random-access byte
 * source. Pure JS: the central directory at the end of the file names every
 * entry with its offsets and sizes; an entry is either stored as is or
 * deflated (pako inflateRaw — the same pako the MDict reader uses).
 *
 * `reader` is `{ size, read(offset, length) → Uint8Array }`, the shape
 * mdx.js's fileReader gives an expo-file-system File (and a Node shim gives
 * a file on disk for the tests). ZIP64 archives are refused: no EPUB is
 * anywhere near 4 GB.
 */
import pako from 'pako';
import { utf8Decode } from './mdx';

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const MAX_COMMENT = 65535;

const u16 = (b, i) => b[i] | (b[i + 1] << 8);
const u32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + b[i + 3] * 0x1000000;

/** Finds the end-of-central-directory record; ZIP comments make its position vary. */
const findEocd = (reader) => {
    const tailLen = Math.min(reader.size, 22 + MAX_COMMENT);
    const tail = reader.read(reader.size - tailLen, tailLen);
    for (let i = tail.length - 22; i >= 0; i--) {
        if (u32(tail, i) === SIG_EOCD) return { bytes: tail, at: i };
    }
    throw new Error('Not a ZIP archive (no end-of-central-directory record)');
};

/**
 * Opens the archive: `{ names, has(name), read(name) → Uint8Array,
 * readText(name) → string }`. Entry names are as stored (forward slashes,
 * no leading slash) — what the EPUB manifest refers to.
 */
export const openZip = (reader) => {
    const { bytes: tail, at } = findEocd(reader);
    const count = u16(tail, at + 10);
    const dirSize = u32(tail, at + 12);
    const dirOffset = u32(tail, at + 16);
    if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
        throw new Error('ZIP64 archives are not supported');
    }
    const dir = reader.read(dirOffset, dirSize);
    const entries = new Map();
    let p = 0;
    for (let n = 0; n < count && p + 46 <= dir.length; n++) {
        if (u32(dir, p) !== SIG_CENTRAL) break;
        const method = u16(dir, p + 10);
        const compressedSize = u32(dir, p + 20);
        const size = u32(dir, p + 24);
        const nameLen = u16(dir, p + 28);
        const extraLen = u16(dir, p + 30);
        const commentLen = u16(dir, p + 32);
        const localOffset = u32(dir, p + 42);
        const name = utf8Decode(dir, p + 46, p + 46 + nameLen);
        entries.set(name, { name, method, compressedSize, size, localOffset });
        p += 46 + nameLen + extraLen + commentLen;
    }

    const read = (name) => {
        const e = entries.get(name);
        if (!e) throw new Error(`Not in the archive: ${name}`);
        // The local header repeats the name and may carry its own extra field;
        // the data follows both.
        const head = reader.read(e.localOffset, 30);
        if (u32(head, 0) !== SIG_LOCAL) throw new Error(`Corrupt entry: ${name}`);
        const dataAt = e.localOffset + 30 + u16(head, 26) + u16(head, 28);
        const raw = reader.read(dataAt, e.compressedSize);
        if (e.method === 0) return raw;
        if (e.method === 8) return pako.inflateRaw(raw);
        throw new Error(`Unsupported compression ${e.method} for ${name}`);
    };

    return {
        names: [...entries.keys()],
        has: (name) => entries.has(name),
        read,
        readText: (name) => {
            const b = read(name);
            // A UTF-8 BOM is not text.
            const start = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
            return utf8Decode(b, start, b.length);
        },
    };
};
