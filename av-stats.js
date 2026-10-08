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

    // Per-day item breakdown (which anime/search/quality — not just a daily total),
    // so the dashboard's Content tab can be filtered to a specific day or range.
    function dailyBump(subpath, extra) {
        var d = db();
        if (!d) return;
        var ref = d.ref(ROOT + '/daily/' + todayKey() + '/' + subpath);
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


    // ───────────────────────── SESSION / AUDIENCE ENGINE ─────────────────────────
    // Bounce rate = sessions that never got "engaged". A session counts as engaged
    // once the visitor opens 2+ pages, does ANY action (watch, search, info card,
    // watchlist, download...) or simply stays 10s+. Counter trick: every new session
    // adds +1 to "bounces"; the first engagement subtracts it again. No per-session
    // nodes are written, so the database stays small.
    var SESSION_GAP = 30 * 60 * 1000;
    var memSess = null, hbStarted = false, engageTimer = null, liveReady = false;
    var liveCtx = { title: null, season: null, episode: null };
    var curPage = 'unknown';

    function loadSession() {
        try { var r = sessionStorage.getItem('av_sess'); return r ? JSON.parse(r) : null; }
        catch (e) { return memSess; }
    }
    function saveSession(s) {
        memSess = s;
        try { sessionStorage.setItem('av_sess', JSON.stringify(s)); } catch (e) {}
    }
    function newId() { return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

    function detectDevice() {
        var ua = navigator.userAgent || '';
        if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
        if (/Mobi|Android|iPhone|iPod/i.test(ua)) return 'mobile';
        return 'desktop';
    }
    function detectBrowser() {
        var ua = navigator.userAgent || '';
        if (/Instagram/i.test(ua)) return 'Instagram in-app';
        if (/FBAN|FBAV/i.test(ua)) return 'Facebook in-app';
        if (/Telegram/i.test(ua)) return 'Telegram in-app';
        if (/EdgA?\/|Edg\//i.test(ua)) return 'Edge';
        if (/OPR\/|Opera/i.test(ua)) return 'Opera';
        if (/SamsungBrowser/i.test(ua)) return 'Samsung Internet';
        if (/UCBrowser/i.test(ua)) return 'UC Browser';
        if (/Firefox|FxiOS/i.test(ua)) return 'Firefox';
        if (/Chrome|CriOS/i.test(ua)) return 'Chrome';
        if (/Safari/i.test(ua)) return 'Safari';
        return 'Other';
    }
    function detectOS() {
        var ua = navigator.userAgent || '';
        if (/Android/i.test(ua)) return 'Android';
        if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
        if (/Windows/i.test(ua)) return 'Windows';
        if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';
        if (/Linux/i.test(ua)) return 'Linux';
        return 'Other';
    }
    function detectSource() {
        var ref = '';
        try { ref = document.referrer || ''; } catch (e) {}
        if (!ref) return 'Direct';
        var host = '';
        try { host = new URL(ref).hostname.replace(/^www\./, ''); } catch (e) { return 'Direct'; }
        if (host === location.hostname.replace(/^www\./, '')) return 'Internal';
        if (/google\./.test(host)) return 'Google';
        if (/bing\.|duckduckgo|yahoo\./.test(host)) return 'Other search';
        if (host === 't.me' || /telegram/.test(host)) return 'Telegram';
        if (/instagram/.test(host)) return 'Instagram';
        if (/facebook|fb\.com|fb\.me/.test(host)) return 'Facebook';
        if (/youtube|youtu\.be/.test(host)) return 'YouTube';
        if (/whatsapp|wa\.me/.test(host)) return 'WhatsApp';
        if (/twitter|x\.com|t\.co/.test(host)) return 'Twitter / X';
        if (/reddit/.test(host)) return 'Reddit';
        return host;
    }

    function dayInc(day, sub, amount) { inc(ROOT + '/daily/' + day + '/' + sub, amount); }

    function markEngaged() {
        var s = loadSession();
        if (!s || s.engaged) return;
        s.engaged = true;
        saveSession(s);
        dayInc(s.day, 'bounces', -1);
    }

    function startSessionIfNeeded(page) {
        var now = Date.now();
        var s = loadSession();
        var fresh = !s || (now - (s.last || 0) > SESSION_GAP);
        if (fresh) {
            s = { id: newId(), day: todayKey(), start: now, last: now, pages: 0, engaged: false, exit: null };
            dayInc(s.day, 'sessions');
            dayInc(s.day, 'bounces');
            dayInc(s.day, 'by_device/' + safeKey(detectDevice()));
            dayInc(s.day, 'by_browser/' + safeKey(detectBrowser()));
            dayInc(s.day, 'by_os/' + safeKey(detectOS()));
            dayInc(s.day, 'by_source/' + safeKey(detectSource()));
            dayInc(s.day, 'by_entry/' + page);
        }
        s.pages = (s.pages || 0) + 1;
        s.last = now;
        // exit page = last page the visitor was on (move the marker as they navigate)
        if (s.exit) dayInc(s.day, 'exit_pages/' + s.exit, -1);
        dayInc(s.day, 'exit_pages/' + page);
        s.exit = page;
        saveSession(s);
        if (s.pages >= 2) markEngaged();
        return s;
    }

    function trackVisitorType() {
        try {
            var day = todayKey();
            if (localStorage.getItem('av_last_day') === day) return;   // already counted today
            var first = !localStorage.getItem('av_first_seen');
            if (first) localStorage.setItem('av_first_seen', String(Date.now()));
            localStorage.setItem('av_last_day', day);
            dailyInc(first ? 'new_visitors' : 'returning_visitors');
        } catch (e) {}
    }

    // Live presence — one small node per open tab, removed automatically on disconnect.
    function pushLive() {
        var d = db();
        if (!d) return;
        var ref = d.ref(ROOT + '/live/' + getClientId());
        if (!liveReady) {
            liveReady = true;
            try { ref.onDisconnect().remove(); } catch (e) {}
        }
        ref.set({
            ts: Date.now(), page: curPage, device: detectDevice(),
            title: liveCtx.title || null, season: liveCtx.season == null ? null : liveCtx.season,
            episode: liveCtx.episode == null ? null : liveCtx.episode
        });
    }

    function startHeartbeat() {
        if (hbStarted) return;
        hbStarted = true;
        pushLive();
        setInterval(function () {
            if (document.hidden) return;
            var s = loadSession();
            if (s) {
                s.last = Date.now();
                saveSession(s);
                dayInc(s.day, 'session_seconds', 30);   // time on site (visible time only)
            }
            pushLive();
        }, 30000);
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) pushLive();
        });
        window.addEventListener('pagehide', function () {
            var d = db();
            if (d) { try { d.ref(ROOT + '/live/' + getClientId()).remove(); } catch (e) {} }
        });
        // 10s on the page = engaged (not a bounce)
        engageTimer = setTimeout(function () { if (!document.hidden) markEngaged(); }, 10000);
    }

    function langKey(label) { return safeKey(String(label || 'unknown').toLowerCase()); }

    // Shared writer for audio-language and caption-language analytics.
    //   kind = 'audio' | 'sub'
    // Writes (all under today's date so every range filter works):
    //   daily/{day}/{kind}_lang/{lang}              -> {label,count}   (selections)
    //   daily/{day}/{kind}_clients/{lang}/{client}  -> true            (unique people)
    //   daily/{day}/{kind}_eps/{slug}/{epKey}/{lang}-> {title,season,episode,label,count}
    function trackLang(kind, slug, title, season, episode, label, source) {
        var d = db();
        if (!d) return;
        slug = safeKey(slug);
        label = label || 'Unknown';
        var lk = langKey(label);
        var day = todayKey();
        var epKey = 's' + safeKey(season) + 'e' + safeKey(episode);
        var base = ROOT + '/daily/' + day + '/';
        var bumpNode = function (path, extra) {
            d.ref(base + path).transaction(function (cur) {
                cur = cur || { count: 0 };
                cur.count = (cur.count || 0) + 1;
                cur.lastAt = Date.now();
                Object.keys(extra).forEach(function (k) { cur[k] = extra[k]; });
                return cur;
            });
        };
        bumpNode(kind + '_lang/' + lk, { label: label });
        bumpNode(kind + '_eps/' + slug + '/' + epKey + '/' + lk,
                 { label: label, title: title || slug, season: season, episode: episode });
        d.ref(base + kind + '_clients/' + lk + '/' + getClientId()).set(true);
        logEvent(kind === 'audio' ? 'audio_select' : 'subtitle_select', {
            slug: slug, title: title || slug, season: season, episode: episode,
            lang: label, source: source || 'user'
        });
    }

    // Seconds watched, split by the audio / caption language that was active.
    function trackLangSeconds(audioLabel, subLabel, seconds) {
        if (!seconds) return;
        if (audioLabel) dailyInc2('audio_secs/' + langKey(audioLabel), seconds);
        if (subLabel) dailyInc2('sub_secs/' + langKey(subLabel), seconds);
    }
    function dailyInc2(sub, amount) { inc(ROOT + '/daily/' + todayKey() + '/' + sub, amount); }

    function logEvent(type, data) {
        var d = db();
        if (!d) return;
        if (type !== 'pageview') markEngaged();
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
            var hh = String(new Date().getHours()).padStart(2, '0');
            dailyInc2('hourly/' + hh);
            curPage = page;
            startSessionIfNeeded(page);
            trackVisitorType();
            startHeartbeat();
            logEvent('pageview', { page: page });
        },

        trackJoinClick: function (location) {
            location = safeKey(location);
            inc(ROOT + '/join_clicks/' + location);
            dailyInc('join_clicks');
            dailyBump('join_clicks_by_loc/' + location);
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
            dailyBump('searches/' + key, { term: term });
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
            liveCtx = { title: title || slug, season: season, episode: episode };
            if (hbStarted) pushLive();
            dailyInc('episode_watches');
            dailyBump('episode_watches_by_title/' + slug, { title: title || slug });
            logEvent('episode_watch', { slug: slug, title: title || slug, season: season, episode: episode });
        },

        // Stored per-episode (so "top watched" can show S/E, not just the anime) AND
        // rolled up per-anime under /total for quick leaderboards.
        trackWatchDuration: function (slug, title, season, episode, seconds, audioLabel, subLabel) {
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
                // same episode's seconds, scoped to today's date bucket for the Content-tab date filter
                var dailyEpRef = d.ref(ROOT + '/daily/' + todayKey() + '/watch_duration/' + slug + '/' + epKey);
                dailyEpRef.transaction(function (cur) {
                    cur = cur || { title: title || slug, season: season, episode: episode, totalSeconds: 0 };
                    cur.title = title || slug;
                    cur.season = season;
                    cur.episode = episode;
                    cur.totalSeconds = (cur.totalSeconds || 0) + seconds;
                    cur.lastAt = Date.now();
                    return cur;
                });
            }
            dailyInc('watch_seconds', seconds);
            trackLangSeconds(audioLabel, subLabel, seconds);
            logEvent('watch_duration', { slug: slug, title: title || slug, season: season, episode: episode, seconds: seconds });
        },

        // Which dub/audio language is playing (source: 'default' on load, 'user' on manual switch)
        trackAudioLang: function (slug, title, season, episode, label, source) {
            trackLang('audio', slug, title, season, episode, label, source);
        },

        // Which caption/subtitle language is on ('Off' included)
        trackSubtitleLang: function (slug, title, season, episode, label, source) {
            trackLang('sub', slug, title, season, episode, label, source);
        },

        trackDownload: function (slug, title, season, episode, quality) {
            slug = safeKey(slug);
            var key = 's' + safeKey(season) + 'e' + safeKey(episode) + '_' + safeKey(quality || 'unknown');
            bump(ROOT + '/downloads/' + slug + '/' + key, {
                title: title || slug, season: season, episode: episode, quality: quality || ''
            });
            dailyInc('downloads');
            var d2 = db();
            if (d2) {
                var dref = d2.ref(ROOT + '/daily/' + todayKey() + '/downloads/' + slug + '/' + key);
                dref.transaction(function (cur) {
                    cur = cur || { title: title || slug, season: season, episode: episode, quality: quality || '', count: 0 };
                    cur.count = (cur.count || 0) + 1;
                    cur.lastAt = Date.now();
                    return cur;
                });
            }
            logEvent('download', { slug: slug, title: title || slug, season: season, episode: episode, quality: quality });
        }
    };

    window.AVAnalytics = AVAnalytics;

})(window);
