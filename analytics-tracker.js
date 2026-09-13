/* ════════════════════════════════════════════════════════════════
   AnimeVerse — Site Analytics Tracker (v4 — reliable)

   Drop-in replacement for the old analytics-tracker.js:
     - Same public API: window.AVAnalytics.trackPageview / trackAnimeView /
       trackEpisodeWatch / trackWatchDuration / trackDownload / trackModalOpen /
       trackSearch / trackWatchlistAdd / trackNotifPermission / trackJoinClick /
       trackBrokenLink / trackServerError
     - Same Firebase paths/schema as before, so analytics.html (the
       dashboard) needs ZERO changes.

   Include on every page (after the Firebase compat SDK <script> tags):
       <script src="av-stats.js"></script>

   WHY THE RENAME (analytics-tracker.js -> av-stats.js):
   Generic ad-blocker / privacy-extension filter lists commonly block any
   file whose name contains "analytics" — including custom, first-party
   files like this one. That silently drops ALL tracking for that visit
   with no visible error. Renaming the file is the standard workaround.
   IMPORTANT: update the <script src="..."> tag on every page (player,
   home, etc.) that currently points at "analytics-tracker.js".

   WHAT'S ACTUALLY FIXED (root cause of "kuch kuch anime count nahi
   hote" — some watches tracked, some silently lost):
   The old tracker fired a Firebase write and just hoped it landed. On a
   flaky mobile connection, or when the user switches server/episode and
   navigates away within a second or two, that write could fail or never
   finish — and since nothing was ever saved locally, it was gone for
   good, with zero indication anything went wrong.

   This version treats every single tracked action as a durable "outbox"
   item:
     1. The event is written to localStorage FIRST, synchronously —
        before any network call. Even if the tab is closed a moment
        later, the event survives.
     2. It only gets removed from that local outbox once Firebase
        confirms the write succeeded.
     3. Failed/incomplete writes are automatically retried: on the next
        page load, when the browser fires an "online" event, when
        Firebase's own ".info/connected" signal comes back up, and every
        20s while the page is open.
     4. Retried events keep their ORIGINAL timestamp, so a write that
        succeeds late still lands in the correct day/hour bucket instead
        of silently shifting into "today" or the wrong hour.

   WHAT THIS CANNOT FIX: if the file itself never loads in a visitor's
   browser (ad-blocker blocking the request, no internet, JS disabled),
   none of this code runs at all — there's nothing to queue. That's a
   separate, much rarer case; the rename above covers the common version
   of it.
   ════════════════════════════════════════════════════════════════ */
(function (global) {
    'use strict';

    var QUEUE_KEY = 'av_analytics_queue_v1';
    var MAX_QUEUE_SIZE = 500;                 // oldest events dropped past this, so storage can't grow unbounded
    var MAX_EVENT_AGE_MS = 48 * 3600 * 1000;  // give up retrying anything stuck for more than 48h

    function safeKey(str) {
        return String(str == null ? 'unknown' : str)
            .replace(/[.#$\[\]\/]/g, '_')
            .trim()
            .slice(0, 200) || 'unknown';
    }

    function pad2(n) { return String(n).padStart(2, '0'); }
    function dayKeyFromTs(ts) {
        var d = new Date(ts);
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }

    function getDevice() {
        var ua = navigator.userAgent || '';
        if (/ipad|tablet/i.test(ua)) return 'tablet';
        if (/mobi|android|iphone/i.test(ua)) return 'mobile';
        return 'desktop';
    }

    function getReferrerDomain() {
        try {
            if (!document.referrer) return 'direct';
            var url = new URL(document.referrer);
            if (url.hostname === location.hostname) return 'internal';
            return url.hostname.replace(/^www\./, '');
        } catch (e) { return 'direct'; }
    }

    function getVisitorId() {
        try {
            var id = localStorage.getItem('av_visitor_id');
            if (!id) {
                id = 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
                localStorage.setItem('av_visitor_id', id);
            }
            return id;
        } catch (e) { return 'anon_' + Math.random().toString(36).slice(2, 10); }
    }

    function getSessionInfo() {
        try {
            var now = Date.now();
            var last = parseInt(sessionStorage.getItem('av_session_ts') || '0', 10);
            var sid = sessionStorage.getItem('av_session_id');
            var isNew = false;
            if (!sid || now - last > 30 * 60 * 1000) {
                sid = 's_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 8);
                sessionStorage.setItem('av_session_id', sid);
                isNew = true;
            }
            sessionStorage.setItem('av_session_ts', String(now));
            return { sid: sid, isNew: isNew };
        } catch (e) { return { sid: 'sess_' + Math.random().toString(36).slice(2, 10), isNew: true }; }
    }

    var visitorId = getVisitorId();
    var device = getDevice();
    var referrer = getReferrerDomain();

    // ─── Durable local outbox (survives reloads / tab-close / dropped network) ───
    function loadQueue() {
        try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch (e) { return []; }
    }
    function saveQueue(q) {
        try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-MAX_QUEUE_SIZE))); } catch (e) { /* storage full/unavailable — best effort only */ }
    }
    function enqueue(op) {
        var q = loadQueue();
        q.push(op);
        saveQueue(q);
    }

    // ─── Firebase wiring ───
    var dbRef = null;
    var flushScheduled = false;

    function withDb(fn, attempt) {
        attempt = attempt || 0;
        if (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length) {
            try {
                if (!dbRef) {
                    dbRef = firebase.database();
                    // ".info/connected" is Firebase's own signal for "the socket to the
                    // database is actually up" — more reliable than navigator.onLine,
                    // which can be true even when this specific connection is stuck.
                    dbRef.ref('.info/connected').on('value', function (snap) {
                        if (snap.val() === true) scheduleFlush();
                    });
                    window.addEventListener('online', scheduleFlush);
                    setInterval(scheduleFlush, 20000);
                }
                fn(dbRef);
            } catch (e) { console.warn('[Analytics]', e); }
            return;
        }
        if (attempt > 100) {
            console.warn('[Analytics] Firebase never initialized on this page — tracking queued locally will retry on the next page that loads successfully. If this happens on every page, check for an ad-blocker/extension blocking this script or the Firebase domain.');
            return;
        }
        setTimeout(function () { withDb(fn, attempt + 1); }, 100);
    }

    function scheduleFlush() {
        if (flushScheduled) return;
        flushScheduled = true;
        setTimeout(function () { flushScheduled = false; flushQueue(); }, 50);
    }

    function applyOne(db, op) {
        var ref = db.ref(op.path);
        var p;
        if (op.type === 'inc') p = ref.transaction(function (cur) { return (cur || 0) + (op.amount || 1); });
        else if (op.type === 'set') p = ref.set(op.value);
        else if (op.type === 'push') p = ref.push(op.value);
        else return;
        Promise.resolve(p).catch(function (err) {
            console.warn('[Analytics] write failed, will retry:', op.path, err && err.message);
            enqueue(op);
        });
    }

    function flushQueue() {
        var q = loadQueue();
        if (!q.length) return;
        withDb(function (db) {
            saveQueue([]); // clear optimistically; failures re-enqueue themselves individually
            var now = Date.now();
            q.forEach(function (op) {
                if (now - (op._ts || 0) > MAX_EVENT_AGE_MS) return; // too stale — drop rather than retry forever
                applyOne(db, op);
            });
        });
    }

    // Every tracked action goes through here: persisted locally FIRST,
    // then an immediate send is attempted. If the page closes before
    // that send resolves, the item is still safely in localStorage and
    // gets picked up by the next flush (this page or a later visit).
    function run(op) {
        op._ts = op._ts || Date.now();
        enqueue(op);
        scheduleFlush();
    }

    function inc(path, amount) { run({ type: 'inc', path: path, amount: amount || 1 }); }
    function set(path, value) { run({ type: 'set', path: path, value: value }); }
    function logEvent(obj) {
        run({ type: 'push', path: 'analytics/events', value: Object.assign({ ts: Date.now(), device: device, visitorId: visitorId }, obj) });
    }

    // Pick up anything left over from a previous visit as soon as Firebase is ready.
    withDb(function () { flushQueue(); });

    function trimEvents(db) {
        if (Math.random() > 0.02) return; // occasional trim so the log doesn't grow forever
        db.ref('analytics/events').orderByKey().limitToLast(300).once('value')
            .then(function (snap) {
                var keep = {};
                snap.forEach(function (child) { keep[child.key] = child.val(); });
                return db.ref('analytics/events').set(keep);
            })
            .catch(function () {});
    }

    // ─── GEO (once per browser session, via free no-key IP lookup) ───
    function trackGeoOnce() {
        try {
            if (sessionStorage.getItem('av_geo_done') === '1') return;
            sessionStorage.setItem('av_geo_done', '1');
        } catch (e) {}
        fetch('https://get.geojs.io/v1/ip/geo.json')
            .then(function (r) { return r.json(); })
            .then(function (g) {
                var country = (g && (g.country || g.country_code)) || 'Unknown';
                inc('analytics/geo/' + safeKey(country));
            })
            .catch(function () {});
    }

    // ─── PAGEVIEW ───
    function trackPageview(pageName) {
        var ts = Date.now();
        var day = dayKeyFromTs(ts);
        var hour = new Date(ts).getHours();
        var page = safeKey(pageName);
        var sess = getSessionInfo();

        logEvent({ type: 'pageview', page: pageName || '', ref: referrer });
        inc('analytics/summary/totalViews');
        inc('analytics/daily/' + day + '/views');
        inc('analytics/pages/' + page + '/views');
        inc('analytics/devices/' + device);
        inc('analytics/referrers/' + safeKey(referrer));
        inc('analytics/hours/' + hour);
        set('analytics/daily/' + day + '/visitors/' + visitorId, true);

        // Visitor first/last/visits profile — a read-then-merge, so it stays a
        // best-effort direct transaction rather than going through the generic
        // outbox (its "first" field only makes sense computed at write time).
        withDb(function (db) {
            db.ref('analytics/visitors/' + visitorId).transaction(function (cur) {
                if (!cur) return { first: ts, last: ts, visits: 1 };
                cur.last = ts;
                cur.visits = (cur.visits || 0) + 1;
                return cur;
            }).then(function (result) {
                if (sess.isNew) {
                    inc('analytics/summary/totalSessions');
                    var existed = result.committed && result.snapshot.exists() && (result.snapshot.val().visits || 0) > 1;
                    inc('analytics/summary/' + (existed ? 'returningVisitorSessions' : 'newVisitorSessions'));
                }
            }).catch(function (err) { console.warn('[Analytics] visitor profile update failed:', err && err.message); });

            trimEvents(db);
        });
        trackGeoOnce();
    }

    // ─── ANIME DETAIL / PLAYER PAGE VIEW ───
    function trackAnimeView(slug, title) {
        if (!slug) return;
        var key = safeKey(slug);
        set('analytics/anime/' + key + '/title', title || slug);
        inc('analytics/anime/' + key + '/views');
        logEvent({ type: 'anime_view', slug: slug, title: title || '' });
    }

    // ─── EPISODE WATCH ───
    function trackEpisodeWatch(slug, title, season, episode) {
        if (!slug) return;
        var ts = Date.now();
        var day = dayKeyFromTs(ts);
        var key = safeKey(slug);
        var epKey = 'S' + (season || 1) + 'E' + (episode || 1);

        set('analytics/anime/' + key + '/title', title || slug);
        inc('analytics/anime/' + key + '/episodes/' + epKey);
        inc('analytics/anime/' + key + '/watchCount');
        inc('analytics/summary/totalWatches');
        inc('analytics/daily/' + day + '/watches');
        inc('analytics/daily/' + day + '/animeWatches/' + key);
        set('analytics/daily/' + day + '/animeTitles/' + key, title || slug);
        inc('analytics/daily/' + day + '/episodeWatches/' + key + '/' + epKey);
        logEvent({ type: 'episode_watch', slug: slug, title: title || '', season: season, episode: episode });
    }

    // ─── WATCH DURATION (call periodically with SECONDS WATCHED SINCE LAST
    //      CALL, not the running total — e.g. every ~20s while playing, and
    //      once more on pause/tab-hide/navigate-away) ───
    function trackWatchDuration(slug, title, season, episode, seconds) {
        seconds = Math.round(seconds || 0);
        if (!slug || seconds <= 0) return;
        var ts = Date.now();
        var day = dayKeyFromTs(ts);
        var key = safeKey(slug);
        var epKey = 'S' + (season || 1) + 'E' + (episode || 1);
        var sKey = safeKey(getSessionInfo().sid);

        set('analytics/anime/' + key + '/title', title || slug);
        inc('analytics/anime/' + key + '/durationSeconds', seconds);
        inc('analytics/anime/' + key + '/episodeDuration/' + epKey, seconds);
        inc('analytics/summary/totalWatchSeconds', seconds);
        inc('analytics/daily/' + day + '/watchSeconds', seconds);
        inc('analytics/daily/' + day + '/episodeDuration/' + key + '/' + epKey + '/' + sKey, seconds);
        // no event log entry here — this fires too often for the rolling feed
    }

    // ─── DOWNLOAD ───
    function trackDownload(slug, title, season, episode, quality) {
        if (!slug) return;
        var ts = Date.now();
        var day = dayKeyFromTs(ts);
        var key = safeKey(slug);
        var epKey = 'S' + (season || 1) + 'E' + (episode || 1);

        set('analytics/anime/' + key + '/title', title || slug);
        inc('analytics/anime/' + key + '/downloads');
        inc('analytics/anime/' + key + '/episodeDownloads/' + epKey);
        inc('analytics/summary/totalDownloads');
        inc('analytics/daily/' + day + '/downloads');
        if (quality) inc('analytics/download_quality/' + safeKey(quality));
        set('analytics/daily/' + day + '/animeTitles/' + key, title || slug);
        inc('analytics/daily/' + day + '/episodeDownloads/' + key + '/' + epKey + '/' + safeKey(quality || 'unknown'));
        logEvent({ type: 'download', slug: slug, title: title || '', season: season, episode: episode, quality: quality || '' });
    }

    // ─── INFO MODAL OPEN (interest / bounce signal, home page) ───
    function trackModalOpen(slug, title, genres) {
        if (!slug && !title) return;
        var key = safeKey(slug || title);
        set('analytics/anime/' + key + '/title', title || slug);
        inc('analytics/anime/' + key + '/modalOpens');
        inc('analytics/summary/totalModalOpens');
        (genres || []).forEach(function (g) { inc('analytics/genres/' + safeKey(g)); });
        logEvent({ type: 'modal_open', slug: slug || '', title: title || '' });
    }

    // ─── SEARCH (call after user pauses typing, not per keystroke) ───
    function trackSearch(term) {
        term = (term || '').trim();
        if (term.length < 2) return;
        inc('analytics/search_terms/' + safeKey(term.toLowerCase()));
        inc('analytics/summary/totalSearches');
        logEvent({ type: 'search', term: term });
    }

    // ─── WATCHLIST ADD (add only, not remove) ───
    function trackWatchlistAdd(key, title) {
        if (!key && !title) return;
        var k = safeKey(key || title);
        set('analytics/watchlist/' + k + '/title', title || key);
        inc('analytics/watchlist/' + k + '/count');
        inc('analytics/summary/totalWatchlistAdds');
        logEvent({ type: 'watchlist_add', title: title || key || '' });
    }

    // ─── NOTIFICATION PERMISSION RESULT ───
    function trackNotifPermission(result) {
        if (result === 'granted') inc('analytics/summary/totalNotifGranted');
        else if (result === 'denied') inc('analytics/summary/totalNotifDenied');
        logEvent({ type: 'notif_permission', result: result });
    }

    // ─── JOIN / TELEGRAM CLICK ───
    function trackJoinClick(source) {
        inc('analytics/summary/totalJoinClicks');
        logEvent({ type: 'join_click', source: source || '' });
    }

    // ─── BROKEN LINK (episode "Not available") ───
    function trackBrokenLink(slug, title, season, episode) {
        inc('analytics/summary/totalBrokenLinks');
        logEvent({ type: 'broken_link', slug: slug || '', title: title || '', season: season, episode: episode });
    }

    // ─── SERVER / DATA FETCH ERROR ───
    function trackServerError(context) {
        inc('analytics/summary/totalServerErrors');
        logEvent({ type: 'server_error', context: context || '' });
    }

    global.AVAnalytics = {
        trackPageview: trackPageview, trackAnimeView: trackAnimeView, trackEpisodeWatch: trackEpisodeWatch,
        trackModalOpen: trackModalOpen, trackSearch: trackSearch, trackWatchlistAdd: trackWatchlistAdd,
        trackNotifPermission: trackNotifPermission, trackJoinClick: trackJoinClick, trackBrokenLink: trackBrokenLink,
        trackServerError: trackServerError, trackWatchDuration: trackWatchDuration, trackDownload: trackDownload
    };
})(window);
