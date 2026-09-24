/**
 * The card for one thing the episode names — a person, a place, a book, a
 * film, a programme, a record. Cover or portrait, what it is, the facts the
 * catalogue had, what the episode itself said about it, and the way out to
 * wherever that kind of thing lives: Goodreads, IMDb, Apple Music, Wikipedia.
 *
 * On Android those are ordinary https links, which the installed app claims
 * through its App Links — so tapping Goodreads opens Goodreads when it is
 * there, and the browser when it is not, with nothing to configure.
 *
 * A podcast is the exception: the way out is into this app. The card finds the
 * show's feed, shows the description the feed carries, and offers Subscribe
 * (services/podcastSubscribe.js) instead of a link to another player.
 *
 * `data` is { entity, startMs } or null; `entity` is an EpisodeEntities row
 * (services/entityIndex.js).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather as Icon } from '@expo/vector-icons';
import { radii, useStyles, useTheme } from '../../theme';
import SheetModal, { SheetIconButton } from './SheetModal';
import { shareText } from './share';
import { TYPE_ICON, TYPE_LABEL } from '../../services/entityIndex';
import { imageSourceFor } from '../../api/wikipedia';
import { lookUpPodcast, subscribeToPodcast } from '../../services/podcastSubscribe';
import { showAlert } from '../AppAlert';

const FOLD_CHARS = 420;

const SOURCE_LABEL = {
    goodreads: 'Goodreads', openlibrary: 'Open Library', wikipedia: 'Wikipedia',
    applemusic: 'Apple Music', appletv: 'Apple TV', applepodcasts: 'Apple Podcasts', tmdb: 'TMDB',
};

/** Where this kind of thing can be opened, beyond whoever answered. */
const elsewhere = (entity) => {
    const q = encodeURIComponent(entity.canonical);
    switch (entity.type) {
        case 'book': return { label: 'Goodreads', url: `https://www.goodreads.com/search?q=${q}` };
        case 'film':
        case 'tv': return { label: 'IMDb', url: `https://www.imdb.com/find/?q=${q}&s=tt` };
        case 'album': return { label: 'Spotify', url: `https://open.spotify.com/search/${q}` };
        case 'podcast': return null;   // Subscribe, in this app
        default: return { label: 'Wikipedia', url: `https://en.wikipedia.org/wiki/Special:Search?search=${q}` };
    }
};

const EntitySheet = ({ data, onClose, onReplay }) => {
    const { colors } = useTheme();
    const st = useStyles(makeStyles);
    const visible = !!data;
    const entity = data?.entity || null;
    const [expanded, setExpanded] = useState(false);
    // A podcast's feed: { feedUrl, description, subscribed }, null while it is
    // looked for, false when no show by that name was found.
    const [show, setShow] = useState(null);
    const [subscribing, setSubscribing] = useState(false);
    const isPodcast = entity?.type === 'podcast';

    useEffect(() => {
        setShow(null);
        setExpanded(false);
        if (!isPodcast) return undefined;
        let live = true;
        lookUpPodcast(entity).then((r) => { if (live) setShow(r || false); }, () => { if (live) setShow(false); });
        return () => { live = false; };
    }, [entity, isPodcast]);

    const subscribe = useCallback(async () => {
        if (!show?.feedUrl || show.subscribed || subscribing) return;
        setSubscribing(true);
        try {
            await subscribeToPodcast(show.feedUrl);
            setShow(s => (s ? { ...s, subscribed: true } : s));
        } catch (e) {
            showAlert('Could not add podcast', e?.message || 'The feed did not load. Try again later.');
        } finally {
            setSubscribing(false);
        }
    }, [show, subscribing]);

    const blurb = ((isPodcast && show?.description) || entity?.blurb || '').trim();
    const folded = !expanded && blurb.length > FOLD_CHARS;
    const shownBlurb = useMemo(() => {
        if (!folded) return blurb;
        const head = blurb.slice(0, FOLD_CHARS);
        const cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('\n'));
        return (cut > FOLD_CHARS * 0.5 ? head.slice(0, cut + 1) : head).trim() + '…';
    }, [blurb, folded]);

    const openUrl = useCallback((url) => { if (url) Linking.openURL(url).catch(() => {}); }, []);
    const onShare = useCallback(() => {
        if (!entity) return;
        const line = entity.subtitle ? `${entity.canonical} — ${entity.subtitle}` : entity.canonical;
        shareText(`${line}\n${entity.source_url || ''}`.trim(), 'Share');
    }, [entity]);

    if (!entity) return <SheetModal visible={false} onClose={onClose} />;

    // The kind's own site, unless that is where the answer already came from —
    // a person found on Wikipedia does not need a second Wikipedia button.
    const other = elsewhere(entity);
    const showOther = !!other && (!entity.source_url || SOURCE_LABEL[entity.source] !== other.label);
    const heardDiffers = entity.surface && entity.surface.toLowerCase() !== entity.canonical.toLowerCase();
    const rating = entity.rating != null ? Number(entity.rating) : null;
    const portrait = entity.type === 'person' || entity.type === 'place';
    // Podcast and record art is square; the book-cover frame cropped it.
    const square = entity.type === 'podcast' || entity.type === 'album';
    // Three buttons do not fit one row at a readable size ("Apple Podca…"):
    // the links keep the first row and Replay takes the whole second one.
    const links = (entity.source_url ? 1 : 0) + (showOther ? 1 : 0) + (isPodcast && show !== false ? 1 : 0);
    const replayOwnRow = links >= 2;

    const header = (
        <>
            <View style={st.labelRow}>
                <Icon name={TYPE_ICON[entity.type] || 'tag'} size={13} color={colors.textMuted} />
                <Text style={st.label}>{TYPE_LABEL[entity.type] || 'Mentioned'}</Text>
                <View style={{ flex: 1 }} />
                <SheetIconButton icon='share-2' label='Share' onPress={onShare} />
            </View>
            <Text style={st.title} numberOfLines={3}>{entity.canonical}</Text>
            {!!entity.subtitle && <Text style={st.subtitle}>{entity.subtitle}</Text>}
        </>
    );

    const footer = (
        <View style={st.actions}>
            {!!entity.source_url && (
                <TouchableOpacity
                    style={[st.actionBtn, st.actionBtnGhost]}
                    onPress={() => openUrl(entity.source_url)}
                    activeOpacity={0.8}
                    accessibilityRole='link'
                    accessibilityLabel={`Open on ${SOURCE_LABEL[entity.source] || 'the web'}`}
                >
                    <Icon name='external-link' size={14} color={colors.accent} />
                    <Text style={[st.actionText, { color: colors.accent }]} numberOfLines={1}>
                        {SOURCE_LABEL[entity.source] || 'Open'}
                    </Text>
                </TouchableOpacity>
            )}
            {showOther && (
                <TouchableOpacity
                    style={[st.actionBtn, st.actionBtnGhost]}
                    onPress={() => openUrl(other.url)}
                    activeOpacity={0.8}
                    accessibilityRole='link'
                    accessibilityLabel={`Open on ${other.label}`}
                >
                    <Icon name='external-link' size={14} color={colors.accent} />
                    <Text style={[st.actionText, { color: colors.accent }]} numberOfLines={1}>{other.label}</Text>
                </TouchableOpacity>
            )}
            {isPodcast && show !== false && (
                <TouchableOpacity
                    style={[st.actionBtn, st.actionBtnGhost]}
                    onPress={subscribe}
                    disabled={!show || show.subscribed || subscribing}
                    activeOpacity={0.8}
                    accessibilityRole='button'
                    accessibilityLabel={show?.subscribed ? 'In My Podcasts' : 'Subscribe in this app'}
                >
                    {!show || subscribing
                        ? <ActivityIndicator size='small' color={colors.accent} />
                        : <Icon name={show.subscribed ? 'check' : 'plus'} size={14} color={colors.accent} />}
                    <Text style={[st.actionText, { color: colors.accent }]} numberOfLines={1}>
                        {show?.subscribed ? 'Subscribed' : 'Subscribe'}
                    </Text>
                </TouchableOpacity>
            )}
            {data?.startMs != null && !!onReplay && (
                <TouchableOpacity
                    style={[st.actionBtn, st.replayBtn, replayOwnRow && st.fullRow]}
                    onPress={() => onReplay(data.startMs)}
                    activeOpacity={0.8}
                    accessibilityRole='button'
                    accessibilityLabel='Play from this mention'
                >
                    <Icon name='rotate-ccw' size={14} color={colors.onAccent} />
                    <Text style={[st.actionText, { color: colors.onAccent }]}>Replay</Text>
                </TouchableOpacity>
            )}
        </View>
    );

    return (
        <SheetModal visible={visible} onClose={onClose} header={header} footer={footer} maxHeight='88%'>
            <View style={st.head}>
                {entity.image_url ? (
                    <View style={[st.image, portrait && st.imagePortrait, square && st.imageSquare, st.imageClip]}>
                        <Image
                            source={imageSourceFor(entity.image_url)}
                            style={[st.imageFill, entity.type === 'person' && st.imageFace]}
                            resizeMode='cover'
                            accessibilityIgnoresInvertColors
                        />
                    </View>
                ) : (
                    <View style={[st.image, portrait && st.imagePortrait, square && st.imageSquare, st.imageEmpty]}>
                        <Icon name={TYPE_ICON[entity.type] || 'tag'} size={22} color={colors.textMuted} />
                    </View>
                )}
                <View style={{ flex: 1, gap: 6 }}>
                    {rating != null && (
                        <View style={st.ratingRow}>
                            <Icon name='star' size={15} color={colors.warning} />
                            <Text style={st.rating}>{rating.toFixed(rating > 10 ? 0 : 1)}</Text>
                            {!!entity.ratings_count && <Text style={st.muted}>· {entity.ratings_count} ratings</Text>}
                        </View>
                    )}
                    {!!entity.facts && <Text style={st.facts}>{entity.facts}</Text>}
                    {heardDiffers && <Text style={st.heard} numberOfLines={2}>Heard as “{entity.surface}”</Text>}
                    <Text style={st.source}>
                        {entity.source ? `Found on ${SOURCE_LABEL[entity.source] || entity.source}` : 'Not found in any catalogue'}
                    </Text>
                </View>
            </View>

            {!!entity.hint && (
                <>
                    <View style={st.divider} />
                    <Text style={st.hintLabel}>In this episode</Text>
                    <Text style={st.hint}>{entity.hint}</Text>
                </>
            )}

            {!!blurb && (
                <>
                    <View style={st.divider} />
                    {shownBlurb.split(/\n+/).map((para, i) => (
                        <Text key={i} style={st.blurb}>{para.trim()}</Text>
                    ))}
                    {folded && (
                        <TouchableOpacity style={st.inlineLink} onPress={() => setExpanded(true)} activeOpacity={0.7} accessibilityRole='button'>
                            <Text style={st.inlineLinkText}>Show more</Text>
                        </TouchableOpacity>
                    )}
                </>
            )}

            {!!entity.context && (
                <>
                    <View style={st.divider} />
                    <Text style={st.context}>“{entity.context}”</Text>
                </>
            )}
        </SheetModal>
    );
};

const makeStyles = (colors) => StyleSheet.create({
    labelRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
    label: { color: colors.textMuted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
    title: { color: colors.textPrimary, fontSize: 26, lineHeight: 32, fontWeight: '700', letterSpacing: -0.4 },
    subtitle: { color: colors.textSecondary, fontSize: 16, lineHeight: 22, fontStyle: 'italic', marginTop: 4, marginBottom: 12 },

    head: { flexDirection: 'row', alignItems: 'flex-start', gap: 16, marginBottom: 6 },
    image: { width: 84, height: 126, borderRadius: 10, backgroundColor: colors.hairlineFaint },
    imagePortrait: { width: 96, height: 96, borderRadius: 48 },
    imageSquare: { width: 110, height: 110 },
    imageEmpty: { alignItems: 'center', justifyContent: 'center', borderWidth: 0.5, borderColor: colors.hairline },
    imageClip: { overflow: 'hidden' },
    imageFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    imageFace: { bottom: undefined, height: 150 },   // the top of a portrait, where the face is
    ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 5, flexWrap: 'wrap' },
    rating: { color: colors.textPrimary, fontSize: 17, fontWeight: '700' },
    muted: { color: colors.textSecondary, fontSize: 14 },
    facts: { color: colors.textSecondary, fontSize: 14 },
    heard: { color: colors.textMuted, fontSize: 13, fontStyle: 'italic' },
    source: { color: colors.textFaint, fontSize: 12, marginTop: 2 },

    divider: { height: 0.5, backgroundColor: colors.hairline, marginVertical: 14 },
    hintLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 4 },
    hint: { color: colors.textPrimary, fontSize: 15, lineHeight: 22 },
    blurb: { color: colors.textSecondary, fontSize: 15, lineHeight: 22, marginBottom: 8 },
    context: { color: colors.textMuted, fontSize: 14, lineHeight: 21, fontStyle: 'italic' },
    inlineLink: { alignSelf: 'flex-start', marginTop: 2, marginBottom: 6 },
    inlineLinkText: { color: colors.accent, fontSize: 13, fontWeight: '600' },

    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingTop: 14 },
    actionBtn: {
        flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        gap: 7, paddingVertical: 13, paddingHorizontal: 10, borderRadius: radii.pill,
    },
    actionBtnGhost: { backgroundColor: colors.hairlineFaint, borderWidth: 0.5, borderColor: colors.hairline },
    replayBtn: { backgroundColor: colors.accent },
    fullRow: { flexBasis: '100%' },
    actionText: { fontSize: 14, fontWeight: '700' },
});

export default EntitySheet;
