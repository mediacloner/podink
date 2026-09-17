/**
 * Live radio (4.0.0) — the station list. Hand-picked English-language talk
 * stations for learners; each carries the stream the app plays / records and
 * where its programme guide comes from (radioSchedule.js).
 *
 * `tz` / `city` are the station's home time zone and city: the screens show
 * the local hour there next to the description, since the programme guide
 * shows times in the listener's own clock and a breakfast show can be on at
 * midnight for them. The list is ordered by how far each station's clock is
 * from the listener's, then by the order below; `sortTz` makes a station sort
 * as if it were in another zone (Vaughan Radio broadcasts from Madrid but
 * belongs with the British stations, after the BBC ones).
 *
 * Streams were verified on 2026-09-06. `kind`:
 *   'hls'          a live HLS playlist (MPEG-TS or packed-audio segments). The
 *                  recorder mirrors it; the player can also play it directly.
 *   'progressive'  an Icecast / SHOUTcast MP3 or ADTS-AAC stream.
 * The BBC international HLS pools change from time to time; when one dies,
 * radio-browser.info lists the current one under the station's name.
 */
// Station logos (assets/radio, PNG renders of the broadcasters' marks; shown
// on a white tile because several are dark-on-transparent).
const LOGOS = {
    bbc_radio_4: require('../../assets/radio/bbc_radio_4.png'),
    abc_rn: require('../../assets/radio/abc_rn.png'),
    rte_radio_1: require('../../assets/radio/rte_radio_1.png'),
    cbc_radio_one: require('../../assets/radio/cbc_radio_one.png'),
    bbc_radio_4_extra: require('../../assets/radio/bbc_radio_4_extra.png'),
    rnz_national: require('../../assets/radio/rnz_national.png'),
    bbc_world_service: require('../../assets/radio/bbc_world_service.png'),
    npr: require('../../assets/radio/npr.png'),
    bbc_radio_scotland: require('../../assets/radio/bbc_radio_scotland.png'),
    bbc_radio_ulster: require('../../assets/radio/bbc_radio_ulster.png'),
    lbc: require('../../assets/radio/lbc.png'),
    wnyc: require('../../assets/radio/wnyc.png'),
    abc_newsradio: require('../../assets/radio/abc_newsradio.png'),
    bbc_radio_5_live: require('../../assets/radio/bbc_radio_5_live.png'),
    bbc_radio_wales: require('../../assets/radio/bbc_radio_wales.png'),
    bbc_radio_london: require('../../assets/radio/bbc_radio_london.png'),
    vaughan_radio: require('../../assets/radio/vaughan_radio.png'),
    kqed: require('../../assets/radio/kqed.png'),
    abc_radio_sydney: require('../../assets/radio/abc_radio_sydney.png'),
};

const RAW_STATIONS = [
    // ── United Kingdom & Ireland: the BBC first, then Vaughan (sorts with them), RTÉ and LBC
    {
        id: 'bbc_radio_4',
        flag: '🇬🇧',
        tz: 'Europe/London',
        city: 'London',
        name: 'BBC Radio 4',
        blurb: 'Best overall',
        detail: 'Speech radio from London: news, documentaries, drama, comedy and long interviews in clear British English.',
        streams: [
            { url: 'https://as-hls-ww-live.akamaized.net/pool_55057080/live/ww/bbc_radio_fourfm/bbc_radio_fourfm.isml/bbc_radio_fourfm-audio%3d96000.norewind.m3u8', kind: 'hls' },
        ],
        guide: { provider: 'bbc', service: 'bbc_radio_fourfm' },
        homepage: 'https://www.bbc.co.uk/sounds/play/live:bbc_radio_fourfm',
    },
    {
        id: 'bbc_radio_4_extra',
        flag: '🇬🇧',
        tz: 'Europe/London',
        city: 'London',
        name: 'BBC Radio 4 Extra',
        blurb: 'Excellent, but much of it is drama, comedy and archive material rather than contemporary conversation',
        detail: 'The BBC’s archive speech station: classic comedy, drama and readings — beautifully spoken, rarely current.',
        streams: [
            { url: 'https://as-hls-ww-live.akamaized.net/pool_26173715/live/ww/bbc_radio_four_extra/bbc_radio_four_extra.isml/bbc_radio_four_extra-audio%3d96000.norewind.m3u8', kind: 'hls' },
        ],
        guide: { provider: 'bbc', service: 'bbc_radio_four_extra' },
        homepage: 'https://www.bbc.co.uk/sounds/play/live:bbc_radio_four_extra',
    },
    {
        id: 'bbc_world_service',
        flag: '🌍',
        tz: 'Europe/London',
        city: 'London',
        name: 'BBC World Service',
        blurb: 'World news and features for an international audience',
        detail: 'The BBC’s international station: news on the hour, documentaries and discussion in measured, global English.',
        streams: [
            { url: 'https://as-hls-ww-live.akamaized.net/pool_87948813/live/ww/bbc_world_service/bbc_world_service.isml/bbc_world_service-audio%3d96000.norewind.m3u8', kind: 'hls' },
            { url: 'http://stream.live.vc.bbcmedia.co.uk/bbc_world_service', kind: 'progressive' },
        ],
        guide: { provider: 'bbc', service: 'bbc_world_service' },
        homepage: 'https://www.bbc.co.uk/sounds/play/live:bbc_world_service',
    },
    {
        id: 'bbc_radio_scotland',
        flag: '🏴󠁧󠁢󠁳󠁣󠁴󠁿',
        tz: 'Europe/London',
        city: 'Glasgow',
        name: 'BBC Radio Scotland',
        blurb: 'News, phone-ins and conversation in Scottish English',
        detail: 'The BBC’s national station for Scotland: news, sport, phone-ins and long conversations — a chance to get used to Scottish accents.',
        streams: [
            { url: 'https://as-hls-ww-live.akamaized.net/pool_43322914/live/ww/bbc_radio_scotland_fm/bbc_radio_scotland_fm.isml/bbc_radio_scotland_fm-audio%3d96000.norewind.m3u8', kind: 'hls' },
        ],
        guide: { provider: 'bbc', service: 'bbc_radio_scotland_fm' },
        homepage: 'https://www.bbc.co.uk/sounds/play/live:bbc_radio_scotland_fm',
    },
    {
        id: 'bbc_radio_ulster',
        flag: '🇬🇧',
        tz: 'Europe/London',
        city: 'Belfast',
        name: 'BBC Radio Ulster',
        blurb: 'Talk and phone-ins from Belfast, in Northern Irish English',
        detail: 'The BBC’s station for Northern Ireland: news, talk, phone-ins and warm local conversation in the Ulster accent.',
        streams: [
            { url: 'https://as-hls-ww-live.akamaized.net/pool_31244774/live/ww/bbc_radio_ulster/bbc_radio_ulster.isml/bbc_radio_ulster-audio%3d96000.norewind.m3u8', kind: 'hls' },
        ],
        guide: { provider: 'bbc', service: 'bbc_radio_ulster' },
        homepage: 'https://www.bbc.co.uk/sounds/play/live:bbc_radio_ulster',
    },
    {
        id: 'bbc_radio_5_live',
        flag: '🇬🇧',
        tz: 'Europe/London',
        city: 'Salford',
        name: 'BBC Radio 5 Live',
        blurb: 'News, sport and phone-ins — fast, informal British English',
        detail: 'The BBC’s news and sport network: rolling news, phone-ins and lively studio chat. Live sport commentary is often blanked outside the UK for rights reasons.',
        streams: [
            { url: 'https://as-hls-ww-live.akamaized.net/pool_89021708/live/ww/bbc_radio_five_live/bbc_radio_five_live.isml/bbc_radio_five_live-audio%3d96000.norewind.m3u8', kind: 'hls' },
        ],
        guide: { provider: 'bbc', service: 'bbc_radio_five_live' },
        homepage: 'https://www.bbc.co.uk/sounds/play/live:bbc_radio_five_live',
    },
    {
        id: 'bbc_radio_wales',
        flag: '🏴󠁧󠁢󠁷󠁬󠁳󠁿',
        tz: 'Europe/London',
        city: 'Cardiff',
        name: 'BBC Radio Wales',
        blurb: 'News, phone-ins and conversation in Welsh English',
        detail: 'The BBC’s national station for Wales: news, phone-ins, sport and long conversations from Cardiff — the Welsh accent in everyday use.',
        streams: [
            { url: 'https://as-hls-ww-live.akamaized.net/pool_97517794/live/ww/bbc_radio_wales_fm/bbc_radio_wales_fm.isml/bbc_radio_wales_fm-audio%3d96000.norewind.m3u8', kind: 'hls' },
        ],
        guide: { provider: 'bbc', service: 'bbc_radio_wales_fm' },
        homepage: 'https://www.bbc.co.uk/sounds/play/live:bbc_radio_wales_fm',
    },
    {
        id: 'bbc_radio_london',
        flag: '🇬🇧',
        tz: 'Europe/London',
        city: 'London',
        name: 'BBC Radio London',
        blurb: 'London’s local BBC station: callers, news and city life',
        detail: 'The BBC’s station for London: local news, phone-ins and long conversations about the city, in the everyday English of Londoners.',
        streams: [
            { url: 'https://as-hls-ww-live.akamaized.net/pool_98137350/live/ww/bbc_london/bbc_london.isml/bbc_london-audio%3d96000.norewind.m3u8', kind: 'hls' },
        ],
        guide: { provider: 'bbc', service: 'bbc_london' },
        homepage: 'https://www.bbc.co.uk/sounds/play/live:bbc_london',
    },
    {
        id: 'vaughan_radio',
        flag: '🇪🇸',
        tz: 'Europe/Madrid',
        city: 'Madrid',
        sortTz: 'Europe/London',
        name: 'Vaughan Radio',
        blurb: 'English lessons on air from Madrid, made for Spanish speakers',
        detail: 'Vaughan Systems’ station: live English classes, drills and chat by native teachers who know exactly where Spanish speakers stumble — explanations in Spanish when needed.',
        streams: [
            { url: 'https://cdn-peer021.streaming-pro.com:8058/vaughanradio.mp3', kind: 'progressive' },
            { url: 'https://vaughanradioweb.streaming-pro.com:8058/vaughanradio.mp3', kind: 'progressive' },
        ],
        guide: { provider: 'vaughan' },
        homepage: 'https://grupovaughan.com/vaughan-radio',
    },
    {
        id: 'rte_radio_1',
        flag: '🇮🇪',
        tz: 'Europe/Dublin',
        city: 'Dublin',
        name: 'RTÉ Radio 1',
        blurb: 'Lots of natural conversation and varied programmes',
        detail: 'Ireland’s national talk station: phone-ins, news, arts and sport in Irish English.',
        streams: [
            { url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/RTE_1_INT.mp3', kind: 'progressive' },
        ],
        guide: { provider: 'rte', service: 'radio1', tz: 'Europe/Dublin' },
        homepage: 'https://www.rte.ie/radio/radio1/',
    },
    {
        id: 'lbc',
        flag: '🇬🇧',
        tz: 'Europe/London',
        city: 'London',
        name: 'LBC',
        blurb: 'Britain’s phone-in station: callers, debate and everyday spoken English',
        detail: 'London’s commercial talk station: presenters and callers arguing the day’s news — fast, natural, unscripted British English.',
        streams: [
            { url: 'https://media-ssl.musicradio.com/LBCLondon', kind: 'progressive' },
            { url: 'https://media-ssl.musicradio.com/LBCLondonMP3', kind: 'progressive' },
        ],
        guide: { provider: 'lbc', service: 'lbc' },
        homepage: 'https://www.lbc.co.uk/',
    },
    // ── North America
    {
        id: 'cbc_radio_one',
        flag: '🇨🇦',
        tz: 'America/Toronto',
        city: 'Toronto',
        name: 'CBC Radio One',
        blurb: 'Excellent conversational English',
        detail: 'Canada’s public talk network (Toronto feed): current affairs, documentaries and warm long-form interviews.',
        streams: [
            { url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/CBLAFM_CBC_SC.mp3', kind: 'progressive' },
        ],
        guide: { provider: 'cbc', service: 'cbc_radio_one_toronto', tz: 'America/Toronto' },
        homepage: 'https://www.cbc.ca/listen/live-radio/1-63-radio-one-toronto',
    },
    {
        id: 'npr',
        flag: '🇺🇸',
        tz: 'America/New_York',
        city: 'Washington',
        name: 'NPR',
        blurb: 'American public radio: news and talk',
        detail: 'The NPR Program Stream — Morning Edition, All Things Considered, Fresh Air and more in American English.',
        streams: [
            { url: 'https://npr-ice.streamguys1.com/live.mp3', kind: 'progressive' },
        ],
        guide: { provider: 'npr', tz: 'America/New_York' },
        homepage: 'https://www.npr.org/',
    },
    {
        id: 'wnyc',
        flag: '🇺🇸',
        tz: 'America/New_York',
        city: 'New York',
        name: 'WNYC',
        blurb: 'New York public radio: NPR news and long-form talk',
        detail: 'New York Public Radio’s flagship: Morning Edition, All Things Considered, The Brian Lehrer Show and Radiolab in American English.',
        streams: [
            { url: 'https://fm939.wnyc.org/wnycfm-web', kind: 'progressive' },
        ],
        guide: { provider: 'wnyc', service: 'wnyc-fm939' },
        homepage: 'https://www.wnyc.org/',
    },
    {
        id: 'kqed',
        flag: '🇺🇸',
        tz: 'America/Los_Angeles',
        city: 'San Francisco',
        name: 'KQED',
        blurb: 'San Francisco public radio — its morning is your evening',
        detail: 'Northern California’s NPR station: Morning Edition, the call-in programme Forum and The California Report, in West Coast American English. Nine hours behind Spain, so its daytime talk runs through the Spanish evening.',
        streams: [
            { url: 'https://hls.kqed.org/hls/kqed_app/playlist.m3u8', kind: 'hls' },
            { url: 'https://streams.kqed.org/kqedradio', kind: 'progressive' },
        ],
        guide: { provider: 'kqed' },
        homepage: 'https://www.kqed.org/radio',
    },
    // ── Australia & New Zealand
    {
        id: 'abc_rn',
        flag: '🇦🇺',
        tz: 'Australia/Sydney',
        city: 'Sydney',
        name: 'ABC Radio National',
        blurb: 'Superb interviews, ideas, science and long-form conversations',
        detail: 'Australia’s national ideas network: science, history, religion, the arts and unhurried conversation.',
        streams: [
            { url: 'https://mediaserviceslive.akamaized.net/hls/live/2038318/rnnsw/index.m3u8', kind: 'hls' },
            { url: 'http://abc.streamguys1.com/live/rnnsw/icecast.audio', kind: 'progressive' },
        ],
        guide: { provider: 'abc', service: 'RN' },
        homepage: 'https://www.abc.net.au/listen/live/rn',
    },
    {
        id: 'abc_newsradio',
        flag: '🇦🇺',
        tz: 'Australia/Sydney',
        city: 'Sydney',
        name: 'ABC NewsRadio',
        blurb: 'Rolling news from Australia, clearly spoken',
        detail: 'The ABC’s continuous news station: bulletins, interviews and the BBC World Service overnight — measured, clear Australian English.',
        streams: [
            { url: 'https://mediaserviceslive.akamaized.net/hls/live/2038311/newsradio/index.m3u8', kind: 'hls' },
            { url: 'http://abc.streamguys1.com/live/newsradio/icecast.audio', kind: 'progressive' },
        ],
        guide: { provider: 'abc', service: 'NEWS' },
        homepage: 'https://www.abc.net.au/listen/live/news',
    },
    {
        id: 'abc_radio_sydney',
        flag: '🇦🇺',
        tz: 'Australia/Sydney',
        city: 'Sydney',
        name: 'ABC Radio Sydney',
        blurb: 'Sydney’s local talk station: callers, city news and chat',
        detail: 'The ABC’s local station for Sydney: breakfast and drive-time talk, phone-ins and city news in relaxed Australian English.',
        streams: [
            { url: 'https://mediaserviceslive.akamaized.net/hls/live/2038302/localsydney/index.m3u8', kind: 'hls' },
            { url: 'http://abc.streamguys1.com/live/localsydney/icecast.audio', kind: 'progressive' },
        ],
        guide: { provider: 'abc', service: 'local_sydney' },
        homepage: 'https://www.abc.net.au/listen/live/sydney',
    },
    {
        id: 'rnz_national',
        flag: '🇳🇿',
        tz: 'Pacific/Auckland',
        city: 'Wellington',
        name: 'RNZ National',
        blurb: 'New Zealand’s public talk station',
        detail: 'Radio New Zealand’s flagship: news, interviews, features and documentaries in New Zealand English.',
        streams: [
            { url: 'http://radionz-ice.streamguys.com/National_aac128', kind: 'progressive' },
            { url: 'https://stream-ice.radionz.co.nz/national.mp3', kind: 'progressive' },
        ],
        guide: { provider: 'rnz', tz: 'Pacific/Auckland' },
        homepage: 'https://www.rnz.co.nz/national',
    },
];

export const STATIONS = RAW_STATIONS.map(s => ({ ...s, logo: LOGOS[s.id] }));

export const getStation = (id) => STATIONS.find(s => s.id === id) || null;

/** feed_url of the Podcasts row that stands for a station. */
export const stationFeedUrl = (stationId) => `radio://${stationId}`;
export const stationIdFromFeedUrl = (feedUrl) => String(feedUrl || '').replace(/^radio:\/\//, '');
/** The station's name as shown in headers and the notification (the logo
 *  carries the identity; the flag is kept in `flag` for text-only places). */
export const stationTitle = (station) => station.name;
