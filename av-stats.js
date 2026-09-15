/*!
 * AVAnalytics — AnimeVerse lightweight analytics tracker
 * Writes structured events to the same Firebase Realtime Database
 * the site already uses, under the top-level "analytics" node.
 * Requires firebase-app-compat.js + firebase-database-compat.js to be
 * loaded first, and firebase.initializeApp(...) to have run before any
 * tracking method is called (the site's inline script does this).
 */
(function (window) {
    'use strict';

    var ROOT = 'analytics';
    var todayKey = function () {
        var d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    };

    function getClientId() {
        try {
            var id = localStorage.getItem('av_client_id');
            if (!id) {
                id = 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
                localStorage.setItem('av_client_id', id);
            }
            return id;
        } catch (e) {
            return 'anon';
        }
    }

    function safeKey(str) {
        return String(str == null ? 'unknown' : str)
            .trim()
            .slice(0, 120)
            .replace(/[.#$/\[\]]/g, '_') || 'unknown';
    }

    function db() {
        try {
            if (window.firebase && firebase.apps && firebase.apps.length) {
                return firebase.database();
            }
        } catch (e) {}
        return null;
    }

    function inc(path, amount) {
        var d = db();
        if (!d) return;
        var ref = d.ref(path);
        try {
            ref.transaction(function (cur) { return (cur || 0) + (amount || 1); });
        } catch (e) {
            ref.once('value').then(function (snap) {
                ref.set((snap.val() || 0) + (amount || 1));
            }).catch(function () {});
        }
    }

    function bump(path, extra) {
        var d = db();
        if (!d) return;
        var ref = d.ref(path);
        ref.transaction(function (cur) {
            cur = cur || { count: 0 };
            cur.count = (cur.count || 0) + 1;
            cur.lastAt = Date.now();
            if (extra) {
                Object.keys(extra).forEach(function (k) { cur[k] = extra[k]; });
            }
            return cur;
        });
    }

    function dailyInc(metric, amount) {
        inc(ROOT + '/daily/' + todayKey() + '/' + safeKey(metric), amount);
    }

    function logEvent(type, data) {
        var d = db();
        if (!d) return;
        var payload = Object.assign({ type: type, ts: Date.now(), client: getClientId() }, data || {});
        d.ref(ROOT + '/recent_events').push(payload);
        // keep the live feed light — trim occasionally from the client
        if (Math.random() < 0.05) {
            d.ref(ROOT + '/recent_events').orderByChild('ts').limitToLast(300).once('value').then(function (snap) {
                var keep = {};
                snap.forEach(function (c) { keep[c.key] = true; });
                d.ref(ROOT + '/recent_events').once('value').then(function (all) {
                    all.forEach(function (c) {
                        if (!keep[c.key]) d.ref(ROOT + '/recent_events/' + c.key).remove();
                    });
                });
            }).catch(function () {});
        }
    }

    var AVAnalytics = {

        trackPageview: function (page) {
            page = safeKey(page);
            var day = todayKey();
            inc(ROOT + '/pageviews/' + page + '_total');
            inc(ROOT + '/pageviews_daily/' + day + '/' + page);
            var d = db();
            if (d) d.ref(ROOT + '/visitors/' + day + '/' + getClientId()).set(Date.now());
            dailyInc('pageviews_' + page);
            logEvent('pageview', { page: page });
        },

        trackJoinClick: function (location) {
            location = safeKey(location);
            inc(ROOT + '/join_clicks/' + location);
            dailyInc('join_clicks');
            logEvent('join_click', { location: location });
        },

        trackServerError: function (context) {
            context = safeKey(context);
            bump(ROOT + '/server_errors/' + context);
            dailyInc('server_errors');
            logEvent('server_error', { context: context });
        },

        trackModalOpen: function (slug, title, genres) {
            slug = safeKey(slug);
            bump(ROOT + '/modal_opens/' + slug, { title: title || slug, genres: genres || '' });
            dailyInc('modal_opens');
            logEvent('modal_open', { slug: slug, title: title || slug });
        },

        trackWatchlistAdd: function (slug, title) {
            slug = safeKey(slug);
            bump(ROOT + '/watchlist_adds/' + slug, { title: title || slug });
            dailyInc('watchlist_adds');
            logEvent('watchlist_add', { slug: slug, title: title || slug });
        },

        trackSearch: function (term) {
            if (!term) return;
            var key = safeKey(String(term).toLowerCase());
            bump(ROOT + '/searches/' + key, { term: term });
            dailyInc('searches');
            logEvent('search', { term: term });
        },

        trackNotifPermission: function (result) {
            result = safeKey(result);
            inc(ROOT + '/notif_permission/' + result);
            dailyInc('notif_' + result);
            logEvent('notif_permission', { result: result });
        },

        trackAnimeView: function (slug, title) {
            slug = safeKey(slug);
            bump(ROOT + '/anime_views/' + slug, { title: title || slug });
            dailyInc('anime_views');
            logEvent('anime_view', { slug: slug, title: title || slug });
        },

        trackBrokenLink: function (slug, title, season, episode) {
            slug = safeKey(slug);
            var epKey = 's' + safeKey(season) + 'e' + safeKey(episode);
            bump(ROOT + '/broken_links/' + slug + '/' + epKey, {
                title: title || slug, season: season, episode: episode
            });
            dailyInc('broken_links');
            logEvent('broken_link', { slug: slug, title: title || slug, season: season, episode: episode });
        },

        trackEpisodeWatch: function (slug, title, season, episode) {
            slug = safeKey(slug);
            var epKey = 's' + safeKey(season) + 'e' + safeKey(episode);
            bump(ROOT + '/episode_watches/' + slug + '/' + epKey, {
                title: title || slug, season: season, episode: episode
            });
            bump(ROOT + '/episode_watches_by_title/' + slug, { title: title || slug });
            dailyInc('episode_watches');
            logEvent('episode_watch', { slug: slug, title: title || slug, season: season, episode: episode });
        },

        // Stored per-episode (so "top watched" can show S/E, not just the anime) AND
        // rolled up per-anime under /total for quick leaderboards.
        trackWatchDuration: function (slug, title, season, episode, seconds) {
            slug = safeKey(slug);
            seconds = Math.max(0, Math.round(Number(seconds) || 0));
            var epKey = 's' + safeKey(season) + 'e' + safeKey(episode);
            var d = db();
            if (d) {
                var totalRef = d.ref(ROOT + '/watch_duration/' + slug + '/total');
                totalRef.transaction(function (cur) {
                    cur = cur || { title: title || slug, totalSeconds: 0, sessions: 0 };
                    cur.title = title || slug;
                    cur.totalSeconds = (cur.totalSeconds || 0) + seconds;
                    cur.sessions = (cur.sessions || 0) + 1;
                    cur.lastAt = Date.now();
                    return cur;
                });
                var epRef = d.ref(ROOT + '/watch_duration/' + slug + '/episodes/' + epKey);
                epRef.transaction(function (cur) {
                    cur = cur || { title: title || slug, season: season, episode: episode, totalSeconds: 0, sessions: 0 };
                    cur.title = title || slug;
                    cur.season = season;
                    cur.episode = episode;
                    cur.totalSeconds = (cur.totalSeconds || 0) + seconds;
                    cur.sessions = (cur.sessions || 0) + 1;
                    cur.lastAt = Date.now();
                    return cur;
                });
            }
            dailyInc('watch_seconds', seconds);
            logEvent('watch_duration', { slug: slug, title: title || slug, season: season, episode: episode, seconds: seconds });
        },

        trackDownload: function (slug, title, season, episode, quality) {
            slug = safeKey(slug);
            var key = 's' + safeKey(season) + 'e' + safeKey(episode) + '_' + safeKey(quality || 'unknown');
            bump(ROOT + '/downloads/' + slug + '/' + key, {
                title: title || slug, season: season, episode: episode, quality: quality || ''
            });
            dailyInc('downloads');
            logEvent('download', { slug: slug, title: title || slug, season: season, episode: episode, quality: quality });
        }
    };

    window.AVAnalytics = AVAnalytics;

})(window);
