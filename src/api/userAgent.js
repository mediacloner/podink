// Some podcast CDNs (e.g. Buzzsprout behind Cloudflare) 403 the default
// Android networking UA ("okhttp/x.y.z") as a bot, while accepting any
// app-identifying UA. Sent on every request to podcast hosts: feed fetch,
// episode download, and remote playback.
const pkg = require('../../package.json');

export const USER_AGENT = `podink/${pkg.version}`;

// <Image> source for podcast artwork. Cover URLs live on the same hosts as
// the feeds, so remote ones need the UA header too (Buzzsprout 403s okhttp);
// local file:// URIs must not get headers.
export const artworkSource = (uri) =>
    /^https?:/i.test(uri || '') ? { uri, headers: { 'User-Agent': USER_AGENT } } : { uri };
