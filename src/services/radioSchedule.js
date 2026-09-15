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
 *   rte   The JSON behind the live-stations strip on rte.ie/radio: the programme
 *         on air (Dublin wall clock) with its description — "now" only; RTÉ
 *         publishes no day schedule the app can reach.
 *   lbc   LBC's schedule page: the week's programmes travel in the page's Astro
 *         island props as JSON with ISO times.
 *   npr   NPR publishes no timetable for its Program Stream; a fixed weekly
 *         line-up (Eastern time) is built in, marked as such under the guide.
 *   kqed  KQED's weekly-schedule page carries every programme's air times as
 *         text ("MON-FRI 9am-11am, 10pm-11pm") in its embedded page state;
 *         they are read into a weekly grid (Pacific time), kept for six hours.
 *   vaughan  Vaughan Radio's page on grupovaughan.com lists each show with its
 *         time ranges and days in Spanish ("De lunes a viernes"); read into a
 *         weekly grid (Madrid time), kept for six hours.
 *   none  No guide; the stream's ICY title, when it carries one, stands in.
 *
 * A guide may carry a `note` (shown under the list) saying where it comes
 * from when that matters. Results are cached for a minute per station; a
 * failed fetch resolves to an empty guide (never throws) and is retried
 * after 20 s.
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

/** Epoch ms of a wall-clock moment in an IANA zone (`h` may be 24 for the
 *  end of a day). One DST-aware pass: the UTC guess is corrected by the
 *  zone's offset at that moment — exact except inside a shifted hour. */
const zonedToMs = (tz, y, m, d, h, min) => {
    const guess = Date.UTC(y, m - 1, d, h, min);
    const p = zoneParts(tz, new Date(guess));
    const seen = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    return guess - (seen - guess);
};

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

// ─── RTÉ Radio 1 ─────────────────────────────────────────────────────────────

// The JSON the "live stations" strip on rte.ie/radio reads: every RTÉ station
// with the programme on air — title, description, Dublin wall-clock start and
// end. That is all RTÉ publishes in a form the app can read (its listings
// page carries TV feeds only), so the guide is "now" without a "coming up".
const fetchRte = async (slug, tz) => {
    const res = await fetchWithTimeout('https://www.rte.ie/radio/live_stations/json');
    const json = await res.json();
    const station = (json?.stations || []).find(st => st?.slug === slug);
    const l = station?.liveListing || {};
    const title = text(l.showTitle || l.showName);
    const note = 'RTÉ publishes only the programme on air.';
    if (!title) return { now: null, next: [], source: 'guide', note };
    const wall = (iso) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(iso || ''));
        return m ? zonedToMs(tz, +m[1], +m[2], +m[3], +m[4], +m[5]) : 0;
    };
    const start = wall(l.showDate);
    let end = wall(l.showEndDate);
    if (!(end > start) && Number(l.duration) > 0) end = start + Number(l.duration);
    const programme = { title, subtitle: '', description: text(l.showDescription || l.description), start, end: end > start ? end : 0 };
    // Whatever the clock says, this is the listing RTÉ calls live.
    const nn = start > 0 && end > start ? nowAndNext([programme]) : { now: null, next: [] };
    return { now: nn.now || programme, next: [], source: 'guide', note };
};

// ─── LBC (Global) ────────────────────────────────────────────────────────────

// The schedule page is rendered by Astro: the week's programmes — every day,
// ISO start and end with the London offset — travel in the RadioSchedule
// island's `props` attribute, the JSON the page itself renders from. Astro
// wraps each value as [kind, value]: 0 a plain value (an object's fields are
// wrapped in turn), 1 an array of wrapped values.
const NAMED_ENTITIES = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: ' ' };
const unescapeAttr = (s) => String(s || '').replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (m, hex, dec, name) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    if (dec) return String.fromCodePoint(Number(dec));
    return NAMED_ENTITIES[name.toLowerCase()] ?? m;
});
const astroValue = (v) => {
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number') {
        return v[0] === 1 ? (Array.isArray(v[1]) ? v[1].map(astroValue) : []) : astroValue(v[1]);
    }
    if (Array.isArray(v)) return v.map(astroValue);
    if (v && typeof v === 'object') {
        const out = {};
        for (const k of Object.keys(v)) out[k] = astroValue(v[k]);
        return out;
    }
    return v;
};

const fetchLbc = async (slug) => {
    const html = await (await fetchWithTimeout(`https://www.lbc.co.uk/radio/schedule/${encodeURIComponent(slug)}/`)).text();
    const island = (html.match(/<astro-island\b[^>]*component-url="[^"]*RadioSchedule[^"]*"[^>]*>/i) || [])[0];
    const raw = island ? (/\sprops="([^"]*)"/.exec(island) || [])[1] : null;
    if (!raw) throw new Error('Schedule data not found in the page');
    const props = astroValue(JSON.parse(unescapeAttr(raw)));
    const items = [];
    for (const day of props?.days || []) {
        for (const ep of day?.episodes || []) {
            const start = Date.parse(ep?.start_date);
            const end = Date.parse(ep?.end_date);
            const title = text(ep?.title);
            if (title && start > 0 && end > start) items.push({ title, subtitle: '', description: text(ep?.description), start, end });
        }
    }
    if (!items.length) throw new Error('Schedule data empty');
    return { ...nowAndNext(items), source: 'guide' };
};

// ─── NPR Program Stream ──────────────────────────────────────────────────────

// NPR publishes no timetable for the stream — only that it "airs recordings
// of recent NPR programs after they air live on NPR Member stations" and may
// be interrupted for news — and the stream's ICY title is blank. This is the
// stream's regular weekly line-up as PublicRadioFan lists it (read
// 2026-09-07), in Eastern wall-clock time; the hours it leaves unlisted are
// gaps here too. Rows: [days (0 Sunday … 6 Saturday), from, to, title].
const NPR_TZ = 'America/New_York';
const NPR_WEEK = [
    ['1', '00:00', '02:00', 'Weekend Edition Sunday'],
    ['23456', '00:00', '02:00', 'Morning Edition'],
    ['0', '00:00', '02:00', 'Weekend Edition Saturday'],
    ['01', '02:00', '04:00', 'Weekend All Things Considered'],
    ['23456', '02:00', '04:00', 'All Things Considered'],
    ['123456', '04:00', '05:00', 'On Point'],
    ['0', '04:00', '05:00', '1A'],
    ['01', '06:00', '08:00', 'Weekend All Things Considered'],
    ['23456', '06:00', '08:00', 'All Things Considered'],
    ['01', '08:00', '09:00', 'Fresh Air Weekend'],
    ['23456', '08:00', '09:00', 'Fresh Air'],
    ['12345', '09:00', '10:00', '1A'],
    ['6', '09:00', '10:00', 'Bullseye'],
    ['0', '09:00', '10:00', 'TED Radio Hour'],
    ['12345', '10:00', '11:00', 'On Point'],
    ['6', '10:00', '11:00', 'Tech Nation'],
    ['0', '11:00', '12:00', 'Snap Judgment'],
    ['06', '12:00', '13:00', 'Fresh Air Weekend'],
    ['12345', '12:00', '14:00', 'Morning Edition'],
    ['06', '13:00', '14:00', 'Wait Wait… Don’t Tell Me!'],
    ['12345', '14:00', '16:00', '1A'],
    ['6', '14:00', '16:00', 'Weekend Edition Saturday'],
    ['0', '14:00', '16:00', 'Weekend Edition Sunday'],
    ['12345', '16:00', '17:00', 'On Point'],
    ['6', '16:00', '17:00', 'Bullseye'],
    ['0', '16:00', '17:00', 'Snap Judgment'],
    ['6', '17:00', '18:00', 'Tech Nation'],
    ['12345', '18:00', '19:00', 'Fresh Air'],
    ['06', '18:00', '19:00', 'TED Radio Hour'],
    ['12345', '19:00', '20:00', '1A'],
    ['06', '19:00', '20:00', 'Fresh Air Weekend'],
    ['12345', '20:00', '21:00', 'On Point'],
    ['06', '20:00', '21:00', 'Weekend All Things Considered'],
    ['06', '21:00', '22:00', 'Wait Wait… Don’t Tell Me!'],
    ['06', '22:00', '24:00', 'Weekend All Things Considered'],
    ['12345', '22:00', '24:00', 'All Things Considered'],
];
const NPR_ABOUT = {
    'Morning Edition': 'NPR’s morning news magazine: the day’s news, interviews and reported features (a replay of the live broadcast).',
    'All Things Considered': 'NPR’s afternoon news magazine: news, analysis, interviews, science and the arts (a replay of the live broadcast).',
    'Weekend Edition Saturday': 'NPR’s Saturday morning news magazine: the week’s news, conversation and features.',
    'Weekend Edition Sunday': 'NPR’s Sunday morning news magazine: news, interviews and the Sunday puzzle.',
    'Weekend All Things Considered': 'The weekend edition of NPR’s afternoon news magazine.',
    'Fresh Air': 'Long-form interviews about books, film, music and ideas, from WHYY in Philadelphia.',
    'Fresh Air Weekend': 'The week’s best Fresh Air interviews.',
    '1A': 'A daily hour of conversation about the news and the ideas behind it, from WAMU in Washington.',
    'On Point': 'One topic a day, examined in depth with experts and callers, from WBUR in Boston.',
    'TED Radio Hour': 'Ideas from TED talks, explored with the people who gave them.',
    'Wait Wait… Don’t Tell Me!': 'NPR’s weekly news quiz, with panellists, guests and callers.',
    'Snap Judgment': 'True stories told with a beat, from KQED in San Francisco.',
    'Bullseye': 'Interviews with the people who make culture — comedy, music, film, books.',
    'Tech Nation': 'Conversations about science, technology and their place in daily life.',
};
const NPR_NOTE = 'Regular weekly line-up of the NPR Program Stream, which replays NPR programmes after their live broadcast; NPR may interrupt it for news. Hours not in the line-up are left blank.';

const nprItems = (nowMs) => {
    const items = [];
    for (const offset of [-1, 0, 1]) {
        const p = zoneParts(NPR_TZ, new Date(nowMs + offset * 86400 * 1000));
        const weekday = String(new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay());
        for (const [days, from, to, title] of NPR_WEEK) {
            if (!days.includes(weekday)) continue;
            const [fh, fm] = from.split(':').map(Number);
            const [th, tm] = to.split(':').map(Number);
            items.push({
                title, subtitle: '', description: NPR_ABOUT[title] || '',
                start: zonedToMs(NPR_TZ, p.y, p.m, p.d, fh, fm),
                end: zonedToMs(NPR_TZ, p.y, p.m, p.d, th, tm),
            });
        }
    }
    return items;
};

const fetchNpr = async () => ({ ...nowAndNext(nprItems(Date.now())), source: 'guide', note: NPR_NOTE });

// ─── Weekly grids (KQED, Vaughan Radio) ──────────────────────────────────────
//
// Two broadcasters publish their line-up only as text per programme, not as a
// timetable. Each is read once into a grid of weekly slots and kept for six
// hours; now / next are then worked out from the grid on every call.
//   slot = { days: [0..6, Sunday first], from, to (minutes into the day; `to`
//            passes 1440 when the show runs past midnight), title, subtitle,
//            description }

const GRID_TTL_MS = 6 * 3600 * 1000;
const _grids = new Map(); // provider key -> { at, slots }

const cachedGrid = async (key, build) => {
    const c = _grids.get(key);
    if (c && Date.now() - c.at < GRID_TTL_MS) return c.slots;
    const slots = await build();
    if (!slots.length) throw new Error('Empty grid');
    _grids.set(key, { at: Date.now(), slots });
    return slots;
};

/** The grid's programmes for yesterday, today and tomorrow in `tz`. */
const weeklyItems = (slots, tz, nowMs) => {
    const items = [];
    for (const offset of [-1, 0, 1]) {
        const p = zoneParts(tz, new Date(nowMs + offset * 86400 * 1000));
        const weekday = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
        for (const sl of slots) {
            if (!sl.days.includes(weekday)) continue;
            items.push({
                title: sl.title, subtitle: sl.subtitle || '', description: sl.description || '',
                start: zonedToMs(tz, p.y, p.m, p.d, Math.floor(sl.from / 60), sl.from % 60),
                end: zonedToMs(tz, p.y, p.m, p.d, Math.floor(sl.to / 60), sl.to % 60),
            });
        }
    }
    return items;
};

/** Weekdays from `a` to `b` going forward round the week ("sat"–"sun", "lunes"–"domingo"). */
const dayRange = (map, a, b) => {
    const out = [];
    let d = map[a];
    const end = b != null && map[b] != null ? map[b] : d;
    for (let i = 0; i < 7; i++) { out.push(d); if (d === end) break; d = (d + 1) % 7; }
    return out;
};

// KQED (San Francisco) — "MON-FRI 9am-11am, 10pm-11pm<br />SAT 8pm-9pm and SUN 11am-12pm"

const KQED_TZ = 'America/Los_Angeles';
const KQED_NOTE = 'Air times as KQED lists them for each programme; the news and station breaks between them are not listed.';
const KQED_DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** Minutes into the day for "9", "4:30" with "am"/"pm"; a start with no
 *  meridiem takes the end's ("12-1pm" = 12:00–13:00). */
const clock12 = (h, m, mer, fallbackMer) => {
    let hh = Number(h) % 12; // 12am → 0, 12pm → 12 (after the pm add)
    if (String(mer || fallbackMer || '').toLowerCase() === 'pm') hh += 12;
    return hh * 60 + Number(m || 0);
};

const KQED_TOKEN = /^(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*(?:\s*-\s*(sun|mon|tue|wed|thu|fri|sat)[a-z]*)?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*-\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/;

/** One programme's air-time text → slots. Pieces without a day keep the
 *  last day span seen; a lone time ("TUE 10pm") is an hour; prose is skipped. */
const parseKqedAirtime = (airtime, programme) => {
    const slots = [];
    let days = null;
    const pieces = String(airtime || '').replace(/<br\s*\/?>/gi, ',').replace(/\s+and\s+/gi, ',').split(',');
    for (const raw of pieces) {
        const m = raw.trim().toLowerCase().match(KQED_TOKEN);
        if (!m) continue;
        if (m[1]) days = dayRange(KQED_DAYS, m[1], m[2]);
        if (!days) continue;
        const from = clock12(m[3], m[4], m[5], m[8]);
        let to = m[6] ? clock12(m[6], m[7], m[8], m[5]) : from + 60;
        if (to <= from) to += 24 * 60;
        slots.push({ days, from, to, ...programme });
    }
    return slots;
};

const fetchKqed = async () => {
    const slots = await cachedGrid('kqed', async () => {
        const html = await (await fetchWithTimeout('https://www.kqed.org/radio/weekly-schedule')).text();
        const m = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/);
        if (!m) throw new Error('No page state');
        const programs = JSON.parse(m[1])?.programsReducer || {};
        const out = [];
        for (const p of Object.values(programs)) {
            if (!p?.airtime || !p?.title) continue;
            out.push(...parseKqedAirtime(p.airtime, { title: text(p.title), subtitle: '', description: text(p.info) }));
        }
        return out;
    });
    const nowMs = Date.now();
    return { ...nowAndNext(weeklyItems(slots, KQED_TZ, nowMs), nowMs), source: 'guide', note: KQED_NOTE };
};

// Vaughan Radio (Madrid) — blocks of "TITLE<br><br>Con PRESENTER", a
// description, then time ranges each followed by the days they apply to.

const VAUGHAN_TZ = 'Europe/Madrid';
const VAUGHAN_NOTE = 'Programme times from Vaughan Radio’s own page; Vaughan lists some shows against each other for the same hour.';
const VAUGHAN_DAYS = { domingo: 0, lunes: 1, martes: 2, miércoles: 3, miercoles: 3, jueves: 4, viernes: 5, sábado: 6, sabado: 6 };

/** "De lunes a viernes" / "Sábado y domingo" / "Domingo" → weekdays, else null. */
const vaughanDays = (line) => {
    const s = line.toLowerCase();
    const range = s.match(/de\s+(\S+)\s+a\s+(\S+)/);
    if (range && VAUGHAN_DAYS[range[1]] != null && VAUGHAN_DAYS[range[2]] != null) return dayRange(VAUGHAN_DAYS, range[1], range[2]);
    const named = Object.keys(VAUGHAN_DAYS).filter(d => s.includes(d)).map(d => VAUGHAN_DAYS[d]);
    return named.length ? [...new Set(named)] : null;
};

/** "THE SHOW WITH NO NAME" → "The Show With No Name". */
const titleCase = (s) => String(s).toLowerCase().replace(/(^|[\s\-(])([a-záéíóúñü])/g, (m, a, b) => a + b.toUpperCase());

const parseVaughanPage = (html) => {
    const slots = [];
    const chunks = html.split('<h3 class="info-piece__title">').slice(1);
    for (const chunk of chunks) {
        const headEnd = chunk.indexOf('</h3>');
        if (headEnd < 0) continue;
        const [rawTitle, ...rest] = chunk.slice(0, headEnd).split(/<br\s*\/?>/i);
        const title = titleCase(text(rawTitle));
        const presenter = text(rest.join(' ')).replace(/^con\s+/i, '').replace(/\s+y\s+/g, ' and ');
        if (!title) continue;
        const body = chunk.slice(headEnd);
        const lines = body.split(/<\/?div[^>]*>/).map(l => text(l)).filter(Boolean);
        const descParts = [];
        let pending = [];
        let sawTime = false;
        for (const line of lines) {
            const t = line.match(/^(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})$/);
            if (t) {
                sawTime = true;
                const from = Number(t[1]) * 60 + Number(t[2]);
                let to = Number(t[3]) * 60 + Number(t[4]);
                if (to <= from) to += 24 * 60;
                pending.push({ from, to });
                continue;
            }
            const days = vaughanDays(line);
            if (days && pending.length) {
                for (const r of pending) {
                    slots.push({ days, from: r.from, to: r.to, title, subtitle: presenter ? `With ${presenter}` : '', description: descParts.join(' ') });
                }
                pending = [];
                continue;
            }
            if (!sawTime && line.length > 30) descParts.push(line);
        }
    }
    return slots;
};

const fetchVaughan = async () => {
    const slots = await cachedGrid('vaughan', async () =>
        parseVaughanPage(await (await fetchWithTimeout('https://grupovaughan.com/vaughan-radio')).text()));
    const nowMs = Date.now();
    return { ...nowAndNext(weeklyItems(slots, VAUGHAN_TZ, nowMs), nowMs), source: 'guide', note: VAUGHAN_NOTE };
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
        case 'rte': return fetchRte(g.service || 'radio1', g.tz || 'Europe/Dublin');
        case 'lbc': return fetchLbc(g.service || 'lbc');
        case 'npr': return fetchNpr();
        case 'kqed': return fetchKqed();
        case 'vaughan': return fetchVaughan();
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

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * The wall clock at a station's home right now (station screens show it next
 * to the description: the guide is in the listener's clock, and a breakfast
 * show can be on at their midnight).
 *   { clock: '14:35', weekday: 'Saturday', dayShift: -1 | 0 | 1 }
 * `dayShift` compares the station's calendar day with the listener's: +1 when
 * it is already tomorrow there, -1 when still yesterday.
 */
export const stationLocalTime = (tz, date = new Date()) => {
    const z = zoneParts(tz, date);
    const there = Date.UTC(z.y, z.m - 1, z.d);
    const here = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    return {
        clock: `${pad2(z.h)}:${pad2(z.min)}`,
        weekday: WEEKDAYS[new Date(there).getUTCDay()],
        dayShift: Math.round((there - here) / 86400000),
    };
};

/** Minutes a zone's wall clock is ahead of UTC at `date` (negative behind). */
export const zoneOffsetMinutes = (tz, date = new Date()) => {
    const z = zoneParts(tz, date);
    const wall = Date.UTC(z.y, z.m - 1, z.d, z.h, z.min);
    const utc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes());
    return Math.round((wall - utc) / 60000);
};

/** How far a zone's clock is from the device's own, in minutes, going the
 *  short way round the day (a clock 23 h ahead is 1 h behind). */
export const zoneDistanceMinutes = (tz, date = new Date()) => {
    const diff = Math.abs(zoneOffsetMinutes(tz, date) + date.getTimezoneOffset()) % 1440;
    return Math.min(diff, 1440 - diff);
};

/** "12 min left" / "ends 14:30" helpers for the now card. */
export const minutesLeft = (programme, nowMs = Date.now()) =>
    programme ? Math.max(0, Math.round((programme.end - nowMs) / 60000)) : 0;
