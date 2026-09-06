/**
 * Programme guides for the live radio stations (4.0.0): what is on air now
 * and the next two programmes.
 *
 * One provider per broadcaster, each returning the same shape:
 *   { now: Programme | null, next: Programme[], source: 'guide' | 'none', fetchedAt }
 *   Programme = { title, subtitle, description, start, end }   (start/end: epoch ms)
 *
 *   bbc   RMS, the JSON the BBC Sounds web player polls; no key needed.
 *   abc   ABC Radio's programitems search; the RN live events are picked out of
 *         each item's `live` publication events (repeats and state feeds too).
 *   cbc   The CBC programme guide page; its rows carry epoch attributes, so
 *         the parse is timezone-proof. Toronto's day is fetched (and tomorrow's
 *         when fewer than two programmes are left in it).
 *   rnz   The RNZ National schedule page: wall-clock times in NZ; each entry
 *         is placed relative to "now" in Pacific/Auckland.
 *   wnyc  WNYC's whats_on JSON: the show on air, plus the next ones when listed.
 *   none  RTÉ, NPR and LBC publish no machine-readable guide the app can reach;
 *         the stream's ICY title, when it carries one, stands in.
 *
 * Results are cached for a minute per station; a failed fetch resolves to an
 * empty guide (never throws) and is retried after 20 s.
 */
import { USER_AGENT } from '../api/userAgent';
import { showNotesPlainText } from './showNotes';
import { log } from './logService';

const TTL_MS = 60 * 1000;
const FAIL_TTL_MS = 20 * 1000;
const FETCH_TIMEOUT_MS = 10 * 1000;
const _cache = new Map(); // stationId -> { at, guide }

const EMPTY = (source = 'none') => ({ now: null, next: [], source, fetchedAt: Date.now() });

const fetchWithTimeout = async (url, init = {}) => {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS) : null;
    try {
        const res = await fetch(url, {
            ...init,
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/html;q=0.9, */*;q=0.8', ...(init.headers || {}) },
            signal: ctrl?.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res;
    } finally {
        if (timer) clearTimeout(timer);
    }
};

const text = (s) => showNotesPlainText(String(s || '')).replace(/\s+/g, ' ').trim();

/** Wall-clock parts of `date` in an IANA zone; UTC when Intl lacks zones. */
const zoneParts = (tz, date = new Date()) => {
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        }).formatToParts(date);
        const get = (t) => Number(parts.find(p => p.type === t)?.value);
        const out = { y: get('year'), m: get('month'), d: get('day'), h: get('hour') % 24, min: get('minute') };
        if ([out.y, out.m, out.d, out.h, out.min].some(Number.isNaN)) throw new Error('parts');
        return out;
    } catch (_) {
        return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate(), h: date.getUTCHours(), min: date.getUTCMinutes() };
    }
};
const pad2 = (n) => String(n).padStart(2, '0');

/** now = the programme containing `nowMs`; next = the two after it. */
const nowAndNext = (items, nowMs = Date.now()) => {
    const sorted = [...items].filter(p => p && p.start > 0).sort((a, b) => a.start - b.start);
    let now = sorted.find(p => p.start <= nowMs && nowMs < p.end) || null;
    if (!now) {
        // Gaps between programmes (news bulletins, changeovers): the one that
        // ended most recently is still what people call "on now".
        const past = sorted.filter(p => p.start <= nowMs);
        const last = past[past.length - 1];
        if (last && nowMs - last.end < 15 * 60 * 1000) now = last;
    }
    const next = sorted.filter(p => p.start > nowMs && (!now || p.start >= now.end - 60_000) && p !== now).slice(0, 2);
    return { now, next };
};

// ─── BBC (RMS) ───────────────────────────────────────────────────────────────

const fetchBbc = async (service) => {
    const res = await fetchWithTimeout(`https://rms.api.bbc.co.uk/v2/broadcasts/poll/${encodeURIComponent(service)}`);
    const json = await res.json();
    const items = (json?.data || []).map(b => ({
        title: text(b?.titles?.primary),
        subtitle: text(b?.titles?.secondary),
        description: text(b?.synopses?.medium || b?.synopses?.short || b?.synopses?.long),
        start: Date.parse(b?.start),
        end: Date.parse(b?.end),
    })).filter(p => p.title);
    return { ...nowAndNext(items), source: 'guide' };
};

// ─── ABC Radio National ──────────────────────────────────────────────────────

const abcStamp = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '');

const fetchAbc = async (service) => {
    const nowMs = Date.now();
    const from = abcStamp(nowMs - 3 * 3600 * 1000);
    const to = abcStamp(nowMs + 8 * 3600 * 1000);
    const url = `https://program.abcradio.net.au/api/v1/programitems/search.json?service=${encodeURIComponent(service)}`
        + `&from=${from}&to=${to}&order=asc&order_by=ppe_date&limit=60`;
    const res = await fetchWithTimeout(url);
    const json = await res.json();
    const items = [];
    for (const it of json?.items || []) {
        const events = Array.isArray(it?.live) ? it.live : [];
        for (const ev of events) {
            const onService = (ev?.outlets || []).some(o => String(o?.partof_service?.service_id || '').toLowerCase() === service.toLowerCase());
            if (!onService) continue;
            const start = Date.parse(ev.start);
            const end = Date.parse(ev.end);
            if (!(start > 0 && end > start)) continue;
            const title = text(it.title || it.program?.title);
            if (!title) continue;
            const series = text(it.program?.title);
            items.push({
                title,
                subtitle: series && series !== title ? series : (ev.schedule_type === 'Repeat' ? 'Repeat' : ''),
                description: text(it.short_synopsis || it.mini_synopsis || it.medium_synopsis || it.program?.short_synopsis),
                start, end,
            });
        }
    }
    // The same event can arrive through several items; keep one per start.
    const byStart = new Map();
    for (const p of items) if (!byStart.has(p.start)) byStart.set(p.start, p);
    return { ...nowAndNext([...byStart.values()], nowMs), source: 'guide' };
};

// ─── CBC Radio One ───────────────────────────────────────────────────────────

const parseCbcDay = (html) => {
    const items = [];
    const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
    for (const row of rows) {
        const s = row.match(/data-start-time-epoch="(\d+)"/);
        const e = row.match(/data-end-time-epoch="(\d+)"/);
        if (!s || !e) continue;
        const dt = row.match(/<dt>([\s\S]*?)<\/dt>/);
        const dd = row.match(/<dd>([\s\S]*?)<\/dd>/);
        const title = text(dt?.[1]);
        if (!title) continue;
        items.push({ title, subtitle: '', description: text(dd?.[1]), start: Number(s[1]), end: Number(e[1]) });
    }
    return items;
};

const fetchCbc = async (service, tz) => {
    const dayUrl = (offsetDays) => {
        const p = zoneParts(tz, new Date(Date.now() + offsetDays * 86400 * 1000));
        return `https://www.cbc.ca/programguide/daily/${p.y}/${pad2(p.m)}/${pad2(p.d)}/${service}`;
    };
    const today = parseCbcDay(await (await fetchWithTimeout(dayUrl(0))).text());
    let items = today;
    const nowMs = Date.now();
    if (today.filter(p => p.start > nowMs).length < 2) {
        try {
            items = today.concat(parseCbcDay(await (await fetchWithTimeout(dayUrl(1))).text()));
        } catch (_) {}
    }
    return { ...nowAndNext(items, nowMs), source: 'guide' };
};

// ─── RNZ National ────────────────────────────────────────────────────────────

const fetchRnz = async (tz) => {
    const html = await (await fetchWithTimeout('https://www.rnz.co.nz/national/schedules')).text();
    const blocks = html.match(/<li class="o-digest o-digest--schedule[\s\S]*?<\/li>/g) || [];
    const nz = zoneParts(tz);
    const nowMin = nz.h * 60 + nz.min;
    const nowMs = Date.now();
    const raw = [];
    for (const b of blocks) {
        const t = b.match(/(\d{1,2}):(\d{2})\s*<small class="ampm">\s*(AM|PM)/i);
        if (!t) continue;
        let h = Number(t[1]) % 12;
        if (/pm/i.test(t[3])) h += 12;
        const minOfDay = h * 60 + Number(t[2]);
        const titleHtml = (b.match(/<\/em>([\s\S]*?)<\/h4>/) || [])[1];
        const title = text(titleHtml);
        if (!title) continue;
        const desc = text((b.match(/<div class="o-digest__detail">([\s\S]*?)<\/div>/) || [])[1]);
        raw.push({ minOfDay, title, description: desc });
    }
    raw.sort((a, b) => a.minOfDay - b.minOfDay);
    const items = raw.map((r, i) => {
        const start = nowMs + (r.minOfDay - nowMin) * 60 * 1000;
        const nextMin = i + 1 < raw.length ? raw[i + 1].minOfDay : r.minOfDay + 60;
        return { title: r.title, subtitle: '', description: r.description, start, end: start + (nextMin - r.minOfDay) * 60 * 1000 };
    });
    return { ...nowAndNext(items, nowMs), source: 'guide' };
};

// ─── WNYC (New York Public Radio) ────────────────────────────────────────────

const wnycShow = (show) => {
    if (!show) return null;
    const start = Date.parse(show.iso_start || show.start);
    const end = Date.parse(show.iso_end || show.end);
    const title = text(show.title || show.show?.title);
    if (!title || !(start > 0)) return null;
    return { title, subtitle: '', description: text(show.description || show.show?.description), start, end: end > start ? end : start + 3600 * 1000 };
};

/** whats_on: the show on air (`current_show`) and, when the station lists
 *  them, the ones after it (`future`). */
const fetchWnyc = async (slug) => {
    const res = await fetchWithTimeout('https://api.wnyc.org/api/v1/whats_on/');
    const json = await res.json();
    const k = json?.[slug] || {};
    const now = wnycShow(k.current_show);
    const future = Array.isArray(k.future) ? k.future : Object.values(k.future || {});
    const items = [now, ...future.map(wnycShow)].filter(Boolean);
    return { ...nowAndNext(items), source: 'guide' };
};

// ─── Public API ──────────────────────────────────────────────────────────────

const fetchFresh = async (station) => {
    const g = station.guide || { provider: 'none' };
    switch (g.provider) {
        case 'bbc': return fetchBbc(g.service);
        case 'abc': return fetchAbc(g.service);
        case 'cbc': return fetchCbc(g.service, g.tz || 'America/Toronto');
        case 'rnz': return fetchRnz(g.tz || 'Pacific/Auckland');
        case 'wnyc': return fetchWnyc(g.service || 'wnyc-fm939');
        default: return EMPTY('none');
    }
};

/** Whether the station has a guide the app can read at all. */
export const hasGuide = (station) => !!station?.guide && station.guide.provider !== 'none';

/**
 * Now / next for a station. Never rejects: an unreachable guide yields
 * `{ now: null, next: [], source: 'error' }` for 20 s, then is retried.
 */
export const fetchGuide = async (station, { force = false } = {}) => {
    const cached = _cache.get(station.id);
    if (!force && cached) {
        const ttl = cached.guide.source === 'error' ? FAIL_TTL_MS : TTL_MS;
        // A cached "now" that has ended is stale even inside the TTL.
        const ended = cached.guide.now && cached.guide.now.end <= Date.now();
        if (Date.now() - cached.at < ttl && !ended) return cached.guide;
    }
    let guide;
    try {
        guide = { ...(await fetchFresh(station)), fetchedAt: Date.now() };
    } catch (e) {
        log('RADIO', 'Guide fetch failed', { station: station.id, error: e?.message || String(e) });
        guide = { ...EMPTY(hasGuide(station) ? 'error' : 'none') };
    }
    _cache.set(station.id, { at: Date.now(), guide });
    return guide;
};

/** "14:05" in the device's local time. */
export const formatClock = (ms) => {
    if (!ms) return '';
    const d = new Date(ms);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/** "12 min left" / "ends 14:30" helpers for the now card. */
export const minutesLeft = (programme, nowMs = Date.now()) =>
    programme ? Math.max(0, Math.round((programme.end - nowMs) / 60000)) : 0;
