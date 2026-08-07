/* ════════════════════════════════════════════════════════════════
   AnimeVerse — Site Analytics Tracker (v3)
   Include on every page (after the Firebase compat SDK <script>
   tags) with:  <script src="analytics-tracker.js"></script>

   It waits for the page's own firebase.initializeApp() call (done
   inline in index.html / player.html) before writing anything, so
   load order relative to that call does not matter.

   Data written under "analytics/" in the SAME Realtime Database
   the site already uses:

   analytics/
     summary/             totalViews, totalWatches, totalSessions,
                           totalModalOpens, totalSearches,
                           totalWatchlistAdds, totalNotifGranted,
                           totalNotifDenied, totalBrokenLinks,
                           totalServerErrors, totalJoinClicks,
                           totalWatchSeconds, totalDownloads,
                           newVisitorSessions, returningVisitorSessions
     visitors/{id}         first, last, visits
     daily/{YYYY-MM-DD}/   views, watches, downloads, watchSeconds,
                           visitors/{id}, animeWatches/{slug}, animeTitles/{slug}
                           episodeWatches/{slug}/{SxEy}            watch count, that day
                           episodeDuration/{slug}/{SxEy}/{sessionId} seconds watched in that
                                                                     session, that day (used to
                                                                     get avg/max watch time per ep)
                           episodeDownloads/{slug}/{SxEy}/{quality} download count, that day
     hours/{0-23}          pageview count by hour-of-day (local time, all-time)
     pages/{page}/         views
     devices/{device}      count
     referrers/{domain}    count
     geo/{country}         count
     genres/{genre}        interest count
     search_terms/{term}   count
     watchlist/{key}/      title, count
     anime/{slug}/         title, views, modalOpens, watchCount, downloads,
                            durationSeconds (total seconds watched, all eps),
                            episodes/{SxEy} (watch count),
                            episodeDuration/{SxEy} (seconds watched),
                            episodeDownloads/{SxEy}
     download_quality/{q}  count
     events/{push}         rolling raw event log (~300 latest) — also used by
                           the dashboard's "Last 24 Hours" view since it's the
                           only place events carry a timestamp
   ════════════════════════════════════════════════════════════════ */
(function (global) {
    'use strict';

    function safeKey(str) {
        return String(str == null ? 'unknown' : str)
            .replace(/[.#$\[\]\/]/g, '_')
            .trim()
            .slice(0, 200) || 'unknown';
    }

    function todayKey(ts) {
        const d = new Date(ts || Date.now());
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    function getDevice() {
        const ua = navigator.userAgent || '';
        if (/ipad|tablet/i.test(ua)) return 'tablet';
        if (/mobi|android|iphone/i.test(ua)) return 'mobile';
        return 'desktop';
    }

    function getReferrerDomain() {
        try {
            if (!document.referrer) return 'direct';
            const url = new URL(document.referrer);
            if (url.hostname === location.hostname) return 'internal';
            return url.hostname.replace(/^www\./, '');
        } catch (e) { return 'direct'; }
    }

    function getVisitorId() {
        try {
            let id = localStorage.getItem('av_visitor_id');
            if (!id) {
                id = 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
                localStorage.setItem('av_visitor_id', id);
            }
            return id;
        } catch (e) { return 'anon_' + Math.random().toString(36).slice(2, 10); }
    }

    function getSessionInfo() {
        try {
            const now = Date.now();
            const last = parseInt(sessionStorage.getItem('av_session_ts') || '0', 10);
            let sid = sessionStorage.getItem('av_session_id');
            let isNew = false;
            if (!sid || now - last > 30 * 60 * 1000) {
                sid = 's_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 8);
                sessionStorage.setItem('av_session_id', sid);
                isNew = true;
            }
            sessionStorage.setItem('av_session_ts', String(now));
            return { sid, isNew };
        } catch (e) { return { sid: 'sess_' + Math.random().toString(36).slice(2, 10), isNew: true }; }
    }

    const visitorId = getVisitorId();
    const device = getDevice();
    const referrer = getReferrerDomain();

    // ─── Wait for the page's own firebase.initializeApp() to have run ───
    function withDb(fn, attempt) {
        attempt = attempt || 0;
        if (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length) {
            try { fn(firebase.database()); } catch (e) { console.warn('[Analytics]', e); }
            return;
        }
        if (attempt > 100) { console.warn('[Analytics] Firebase never initialized — tracking disabled.'); return; }
        setTimeout(() => withDb(fn, attempt + 1), 100);
    }

    function inc(ref) { ref.transaction(cur => (cur || 0) + 1); }
    function logEvent(db, obj) { db.ref('analytics/events').push(Object.assign({ ts: Date.now(), device, visitorId }, obj)); }

    function trimEvents(db) {
        if (Math.random() > 0.02) return; // occasional trim so it doesn't grow forever
        db.ref('analytics/events').orderByKey().limitToLast(300).once('value', snap => {
            const keep = {};
            snap.forEach(child => { keep[child.key] = child.val(); });
            db.ref('analytics/events').set(keep);
        });
    }

    // ─── GEO (once per browser session, via free no-key IP lookup) ───
    function trackGeoOnce() {
        try {
            if (sessionStorage.getItem('av_geo_done') === '1') return;
            sessionStorage.setItem('av_geo_done', '1');
        } catch (e) {}
        fetch('https://get.geojs.io/v1/ip/geo.json')
            .then(r => r.json())
            .then(g => {
                const country = (g && (g.country || g.country_code)) || 'Unknown';
                withDb(db => inc(db.ref('analytics/geo/' + safeKey(country))));
            })
            .catch(() => {});
    }

    // ─── PAGEVIEW ───
    function trackPageview(pageName) {
        withDb(db => {
            const ts = Date.now();
            const day = todayKey(ts);
            const hour = new Date(ts).getHours();
            const page = safeKey(pageName);
            const { isNew } = getSessionInfo();

            logEvent(db, { type: 'pageview', page: pageName || '', ref: referrer });

            inc(db.ref('analytics/summary/totalViews'));
            inc(db.ref('analytics/daily/' + day + '/views'));
            inc(db.ref('analytics/pages/' + page + '/views'));
            inc(db.ref('analytics/devices/' + device));
            inc(db.ref('analytics/referrers/' + safeKey(referrer)));
            inc(db.ref('analytics/hours/' + hour));
            db.ref('analytics/daily/' + day + '/visitors/' + visitorId).set(true);

            db.ref('analytics/visitors/' + visitorId).transaction(cur => {
                if (!cur) return { first: ts, last: ts, visits: 1 };
                cur.last = ts;
                cur.visits = (cur.visits || 0) + 1;
                return cur;
            });

            if (isNew) {
                inc(db.ref('analytics/summary/totalSessions'));
                db.ref('analytics/visitors/' + visitorId).once('value', snap => {
                    const existed = snap.exists() && (snap.val().visits || 0) > 1;
                    inc(db.ref('analytics/summary/' + (existed ? 'returningVisitorSessions' : 'newVisitorSessions')));
                });
            }
            trimEvents(db);
        });
        trackGeoOnce();
    }

    // ─── ANIME DETAIL / PLAYER PAGE VIEW ───
    function trackAnimeView(slug, title) {
        if (!slug) return;
        withDb(db => {
            const key = safeKey(slug);
            db.ref('analytics/anime/' + key + '/title').set(title || slug);
            inc(db.ref('analytics/anime/' + key + '/views'));
            logEvent(db, { type: 'anime_view', slug, title: title || '' });
        });
    }

    // ─── EPISODE WATCH ───
    function trackEpisodeWatch(slug, title, season, episode) {
        if (!slug) return;
        withDb(db => {
            const ts = Date.now();
            const day = todayKey(ts);
            const key = safeKey(slug);
            const epKey = 'S' + (season || 1) + 'E' + (episode || 1);
            db.ref('analytics/anime/' + key + '/title').set(title || slug);
            inc(db.ref('analytics/anime/' + key + '/episodes/' + epKey));
            inc(db.ref('analytics/anime/' + key + '/watchCount'));
            inc(db.ref('analytics/summary/totalWatches'));
            inc(db.ref('analytics/daily/' + day + '/watches'));
            // Per-day, per-anime watch count — powers a "Today" top-anime list
            inc(db.ref('analytics/daily/' + day + '/animeWatches/' + key));
            db.ref('analytics/daily/' + day + '/animeTitles/' + key).set(title || slug);
            // Per-day, per-episode watch count — powers "Today's most watched episode"
            inc(db.ref('analytics/daily/' + day + '/episodeWatches/' + key + '/' + epKey));
            logEvent(db, { type: 'episode_watch', slug, title: title || '', season, episode });
        });
    }

    // ─── WATCH DURATION (call periodically with SECONDS WATCHED SINCE LAST
    //      CALL, not the running total — e.g. every ~20s while playing, and
    //      once more on pause/tab-hide/navigate-away) ───
    function trackWatchDuration(slug, title, season, episode, seconds) {
        seconds = Math.round(seconds || 0);
        if (!slug || seconds <= 0) return;
        withDb(db => {
            const ts = Date.now();
            const day = todayKey(ts);
            const key = safeKey(slug);
            const epKey = 'S' + (season || 1) + 'E' + (episode || 1);
            const sKey = safeKey(getSessionInfo().sid);
            db.ref('analytics/anime/' + key + '/title').set(title || slug);
            db.ref('analytics/anime/' + key + '/durationSeconds').transaction(cur => (cur || 0) + seconds);
            db.ref('analytics/anime/' + key + '/episodeDuration/' + epKey).transaction(cur => (cur || 0) + seconds);
            db.ref('analytics/summary/totalWatchSeconds').transaction(cur => (cur || 0) + seconds);
            db.ref('analytics/daily/' + day + '/watchSeconds').transaction(cur => (cur || 0) + seconds);
            // Per-day, per-episode, per-session accumulated seconds — powers
            // "today's most watched episode" avg/max watch-duration figures
            db.ref('analytics/daily/' + day + '/episodeDuration/' + key + '/' + epKey + '/' + sKey).transaction(cur => (cur || 0) + seconds);
            // no event log entry here — this fires too often for the rolling feed
        });
    }

    // ─── DOWNLOAD ───
    function trackDownload(slug, title, season, episode, quality) {
        if (!slug) return;
        withDb(db => {
            const ts = Date.now();
            const day = todayKey(ts);
            const key = safeKey(slug);
            const epKey = 'S' + (season || 1) + 'E' + (episode || 1);
            db.ref('analytics/anime/' + key + '/title').set(title || slug);
            inc(db.ref('analytics/anime/' + key + '/downloads'));
            inc(db.ref('analytics/anime/' + key + '/episodeDownloads/' + epKey));
            inc(db.ref('analytics/summary/totalDownloads'));
            inc(db.ref('analytics/daily/' + day + '/downloads'));
            if (quality) inc(db.ref('analytics/download_quality/' + safeKey(quality)));
            // Per-day, per-episode, per-quality download count — powers
            // "today's downloads by episode & quality" list
            db.ref('analytics/daily/' + day + '/animeTitles/' + key).set(title || slug);
            inc(db.ref('analytics/daily/' + day + '/episodeDownloads/' + key + '/' + epKey + '/' + safeKey(quality || 'unknown')));
            logEvent(db, { type: 'download', slug, title: title || '', season, episode, quality: quality || '' });
        });
    }

    // ─── INFO MODAL OPEN (interest / bounce signal, home page) ───
    function trackModalOpen(slug, title, genres) {
        if (!slug && !title) return;
        withDb(db => {
            const key = safeKey(slug || title);
            db.ref('analytics/anime/' + key + '/title').set(title || slug);
            inc(db.ref('analytics/anime/' + key + '/modalOpens'));
            inc(db.ref('analytics/summary/totalModalOpens'));
            (genres || []).forEach(g => inc(db.ref('analytics/genres/' + safeKey(g))));
            logEvent(db, { type: 'modal_open', slug: slug || '', title: title || '' });
        });
    }

    // ─── SEARCH (call after user pauses typing, not per keystroke) ───
    function trackSearch(term) {
        term = (term || '').trim();
        if (term.length < 2) return;
        withDb(db => {
            inc(db.ref('analytics/search_terms/' + safeKey(term.toLowerCase())));
            inc(db.ref('analytics/summary/totalSearches'));
            logEvent(db, { type: 'search', term });
        });
    }

    // ─── WATCHLIST ADD (add only, not remove) ───
    function trackWatchlistAdd(key, title) {
        if (!key && !title) return;
        withDb(db => {
            const k = safeKey(key || title);
            db.ref('analytics/watchlist/' + k + '/title').set(title || key);
            inc(db.ref('analytics/watchlist/' + k + '/count'));
            inc(db.ref('analytics/summary/totalWatchlistAdds'));
            logEvent(db, { type: 'watchlist_add', title: title || key || '' });
        });
    }

    // ─── NOTIFICATION PERMISSION RESULT ───
    function trackNotifPermission(result) {
        withDb(db => {
            if (result === 'granted') inc(db.ref('analytics/summary/totalNotifGranted'));
            else if (result === 'denied') inc(db.ref('analytics/summary/totalNotifDenied'));
            logEvent(db, { type: 'notif_permission', result });
        });
    }

    // ─── JOIN / TELEGRAM CLICK ───
    function trackJoinClick(source) {
        withDb(db => {
            inc(db.ref('analytics/summary/totalJoinClicks'));
            logEvent(db, { type: 'join_click', source: source || '' });
        });
    }

    // ─── BROKEN LINK (episode "Not available") ───
    function trackBrokenLink(slug, title, season, episode) {
        withDb(db => {
            inc(db.ref('analytics/summary/totalBrokenLinks'));
            logEvent(db, { type: 'broken_link', slug: slug || '', title: title || '', season, episode });
        });
    }

    // ─── SERVER / DATA FETCH ERROR ───
    function trackServerError(context) {
        withDb(db => {
            inc(db.ref('analytics/summary/totalServerErrors'));
            logEvent(db, { type: 'server_error', context: context || '' });
        });
    }

    global.AVAnalytics = {
        trackPageview, trackAnimeView, trackEpisodeWatch, trackModalOpen,
        trackSearch, trackWatchlistAdd, trackNotifPermission, trackJoinClick,
        trackBrokenLink, trackServerError, trackWatchDuration, trackDownload
    };
})(window);
