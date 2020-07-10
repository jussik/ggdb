(() => {
let sqlJsPromise;
function getSqlJs() {
    return sqlJsPromise || (sqlJsPromise = initSqlJs({
        locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.3.0/dist/${file}`
    }));
}

Vue.component("game-view", {
    props: ["game", "igdb"],
    template: "#gameViewTemplate",
    methods: {
        showDetails: function() {
            console.log(this.$props.game.title);
            console.log(JSON.parse(JSON.stringify(this.$props.game)));
            console.log(JSON.parse(JSON.stringify(this.$props.igdb)));
            this.$emit("show-screenshots", this.$props.game.screenshots);
        }
    }
});

window.app = new Vue({
    el: "#app",
    data: {
        loading: false,
        games: [],
        igdb: {},
        hiddenPlatforms: {},
        filter: "",
        screenshots: []
    },
    components: {
        agile: VueAgile
    },
    computed: {
        platforms: function() {
            const plats = new Set();
            for (let game of this.games) {
                for (let plat of game.platforms) {
                    plats.add(plat);
                }
            }
            return Array.from(plats).sort();
        },
        filterTokens: function() {
            if (!this.filter)
                return null;
            return this.filter.toLowerCase().split(/\s+/g);
        }
    },
    created: function() {
        function loadFromStorage(key) {
            let json = localStorage[key];
            if (json) {
                try {
                    if (json[0] !== "[" && json[0] !== "{") {
                        json = LZString.decompressFromUTF16(json);
                        if (!json)
                            throw new Error("Failed to decompress " + key);
                    }
                    return JSON.parse(json);
                } catch (err) {
                    console.error(`Error loading ${key} from localStorage`);
                    console.error(err);
                    localStorage.removeItem("ggdb_games");
                    return null;
                }
            }
        }

        this.games = loadFromStorage("ggdb_games") || this.games;
        this.igdb = loadFromStorage("ggdb_igdb") || this.igdb;
        this.prepareGames();
        console.log("Call app.fetchGameDetailsBatch() to fetch any missing details from IGDB");
    },
    methods: {
        updateGameIndex: function(g) {
            const tokens = [g.title, ...g.genres, ...g.themes, g.summary];
            const igdb = this.igdb[g.gameId];
            if (igdb && igdb.keywords)
                tokens.push(...igdb.keywords);
            g._textIndex = tokens.join("\t").toLowerCase();
        },
        prepareGames: function() {
            this.games.forEach(g => this.updateGameIndex(g));
            this.sortByName();
        },
        loadDbFile: function (ev) {
            this.loading = true;
            const file = ev.dataTransfer.files[0];
            const r = new FileReader();
            r.onload = () => {
                getSqlJs().then(sqlJs => {
                    setTimeout(() => {
                        // in a timeout to ensure loading text is visible
                        const db = new sqlJs.Database(new Uint8Array(r.result));
                        this.importGames(db);
                        this.loading = false;
                    });
                });
            };
            r.readAsArrayBuffer(file);
        },
        importGames: function (db) {
            function processTitles(type, obj) {
                if (type === "title")
                    return obj;
                for (let k in obj) {
                    if (k === "title") {
                        obj[type] = obj[k];
                        delete obj[k];
                        return obj;
                    }
                }
                return obj;
            }

            console.time("importing");
            const stmt = db.prepare(`
                select rp.gameid, p.releasekey, ifnull(pc.platform, 'gog') as platform, ppd.addeddate, t.type, p.value
                from GamePieces p
                join LibraryReleases lr on p.releasekey = lr.releasekey
                join ReleaseProperties rp on p.releasekey = rp.releasekey
                    and isvisibleinlibrary = 1
                join GamePieceTypes t on p.gamePieceTypeId = t.id
                left join PlatformConnections pc on p.releasekey like pc.platform || '_%'
                    and pc.connectionstate = 'Connected'
                left join ProductPurchaseDates ppd on ppd.gamereleasekey = p.releasekey
                where pc.platform is not null or p.releasekey like 'gog_%';`);
            const gamesById = {};
            try {
                while(stmt.step()) {
                    const [gameId, releaseKey, platform, addedDate, type, json] = stmt.get();
                    const game = gamesById[gameId] || (gamesById[gameId] = { });
                    const release = game[releaseKey] || (game[releaseKey] = { gameId, platform, addedDate });
                    Object.assign(release, processTitles(type, JSON.parse(json)));
                }
            } finally {
                stmt.free();
            }

            const games = Object.values(gamesById)
                .map(rs => {
                    const sortedReleases = Object.values(rs)
                        // games without verticalCover are not visible in galaxy either
                        .filter(g => g.verticalCover)
                        // sort first by title length, then by platform name to get rid of "Windows 10 edition" and "Origin Key"
                        .sort((a, b) => (a.title.length - b.title.length) || a.platform.localeCompare(b.platform));
                    return sortedReleases.length ? {
                        ...sortedReleases[0],
                        otherPlatforms: sortedReleases.slice(1),
                        addedDate: sortedReleases
                            .map(r => r.addedDate)
                            .reduce((a, b) => (a || "").localeCompare(b || "") ? b : a, "")
                    } : null;
                })
                .filter(r => r)
                .map(g => {
                    const plats = new Set(g.otherPlatforms.map(r => r.platform));
                    plats.add(g.platform);
                    const steamRelease = g.releases.find(gr => gr.startsWith("steam_"));
                    let year = g.releaseDate && new Date(g.releaseDate * 1000).getFullYear();
                    if (!year || year <= 1970)
                        year = null;
                    const title = g.title || g.originalTitle;
                    const sortingTitle = g.sortingTitle || g.originalSortingTitle;
                    return {
                        gameId: g.gameId,
                        addedDate: g.addedDate || "",
                        steamAppId: steamRelease ? steamRelease.split("_")[1] : undefined,
                        title,
                        sortingTitle: title !== sortingTitle ? sortingTitle : undefined,
                        verticalCover: g.verticalCover,
                        genres: g.genres,
                        themes: g.themes,
                        summary: g.summary,
                        year: year,
                        platforms: Array.from(plats.values()).sort(),
                        screenshots: g.screenshots
                            ?  g.screenshots.map(f => f.replace("{formatter}", "").replace("{ext}", "jpg"))
                            : []
                    }
                });
            console.timeEnd("importing");

            this.games = games;
            this.saveGames();
            this.prepareGames();
        },
        togglePlatform: function (plat) {
            Vue.set(this.hiddenPlatforms, plat, !this.hiddenPlatforms[plat]);
        },
        isGameVisible: function(game) {
            if (!game.platforms.some(p => !this.hiddenPlatforms[p]))
                return false;
            if (this.filterTokens)
                return this.filterTokens.every(filter => game._textIndex.indexOf(filter) !== -1);
            return true;
        },
        sortByName: function() {
            this.games.sort((a, b) => (a.sortingTitle || a.title).localeCompare(b.sortingTitle || b.title));
        },
        sortByYear: function() {
            this.games.sort((a, b) => {
                return (b.year || 0) - (a.year || 0)
                    // fall back to sorting by title if same score
                    || (a.sortingTitle || a.title).localeCompare(b.sortingTitle || b.title);
            });
        },
        sortByAdded: function() {
            this.games.sort((a, b) => b.addedDate.localeCompare(a.addedDate)
                || (a.sortingTitle || a.title).localeCompare(b.sortingTitle || b.title));
        },
        sortByIgdbValue: function(key) {
            this.games.sort((a, b) => {
                const ia = this.igdb[a.gameId];
                const ib = this.igdb[b.gameId];
                return (ib && ib[key] || 0) - (ia && ia[key] || 0)
                    // fall back to sorting by title if same score
                    || (a.sortingTitle || a.title).localeCompare(b.sortingTitle || b.title);
            });
        },
        sortByRating: function() {
            this.sortByIgdbValue("rating");
        },
        sortByRatingCount: function() {
            this.sortByIgdbValue("ratingCount");
        },
        shuffle: function() {
            const games = this.games;
            for (let i = games.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [games[i], games[j]] = [games[j], games[i]];
            }
            games.splice(); // notify Vue
        },
        showScreenshots: function (screenshots) {
            this.screenshots = screenshots;
        },
        saveImpl: function (caller, key, data) {
            console.time("saving " + key);
            const enableCompression = localStorage.ggdb_enableCompression === "true";
            try {
                // ignore private props like _textIndex
                let json = JSON.stringify(data, (k, v) => k[0] === "_" ? undefined : v);
                if (enableCompression)
                    json = LZString.compressToUTF16(json);
                localStorage[key] = json;
            } catch (err) {
                console.error("Failed to write to localStorage");
                console.error(err);
                if (!enableCompression) {
                    console.log("If insufficient storage space, try again using compression:");
                    console.log(`localStorage.ggdb_enableCompression = true; ${caller}();`);
                }
                localStorage.removeItem("key");
            }
            console.timeEnd("saving " + key);
        },
        saveGames: function () {
            this.saveImpl("saveGames", "ggdb_games", this.games);
        },
        saveIgdb: function () {
            this.saveImpl("saveIgdb", "ggdb_igdb", this.igdb);
        },
        queryIgdb: async function (resource, query) {
            console.time("igdb query " + resource);
            try {
                let key = localStorage.ggdb_igdbKey;
                let keyEntered = false;
                if (!key) {
                    key = prompt("Please enter your IGDB key to load additional information:");
                    if (!key) {
                        console.log("IGDB key skipped");
                        return;
                    }
                    keyEntered = true;
                }

                const res = await fetch(
                    // use cors-anywhere as proxy until IGDB supports CORS
                    "https://cors-anywhere.herokuapp.com/https://api-v3.igdb.com/" + resource,
                    {
                        method: "POST",
                        body: query,
                        headers: {
                            "Accept": "application/json",
                            "Content-Type": "text/plain",
                            "user-key": key
                        },
                        mode: "cors"
                    });

                if (res.status !== 200) {
                    const errorText = res.text();
                    throw `Error ${res.status}: ${errorText}`;
                }

                const results = await res.json();
                if (keyEntered)
                    localStorage.ggdb_igdbKey = key;

                return results;
            } finally {
                console.timeEnd("igdb query " + resource);
            }
        },
        initIgDbEntry: function (game) {
            if (!game)
                return {};
            const o = { rating: game.total_rating, ratingCount: game.total_rating_count };
            if (game.keywords && game.keywords.length > 0) {
                o.keywords = game.keywords.map(k => k.name);
            }
            const ttb = game.time_to_beat;
            if (ttb) {
                function getHours(seconds) {
                    const tenthHours = Math.round(seconds / 360);
                    return tenthHours > 100 ? tenthHours : Math.round(seconds / 360) / 10; // show decimal if <10h
                }

                if (ttb.normally)
                    o.normalHours = getHours(ttb.normally);
                if (ttb.hastly)
                    o.fastHours = getHours(ttb.hastly);
                if (ttb.completely)
                    o.completeHours = getHours(ttb.completely);
            }
            return o;
        },
        fetchGameDetailsBatchBySteamIdAsync: async function () {
            const gameEntries = this.games
                .filter(g => g.steamAppId && !this.igdb[g.gameId] && !g.igdbSteamAttempted)
                .slice(0, 100)
                .map(g => [g.steamAppId, g]);

            if (gameEntries.length === 0)
                return [false, false];

            console.log(`querying ${gameEntries.length} steam ids`);
            gameEntries.forEach(([, g]) => g.igdbSteamAttempted = true);

            const gamesBySteamId = Object.fromEntries(gameEntries);
            const results = await this.queryIgdb("external_games", `
                fields uid, game.total_rating, game.total_rating_count, game.keywords.name, game.time_to_beat.*;
                where category = 1 & uid = (${gameEntries.map(([s]) => `"${s}"`).join(",")});
                limit 500;`);

            results.forEach(r => {
                const game = gamesBySteamId[r.uid];
                game.igdbSteamAttempted = true;
                Vue.set(this.igdb, game.gameId, this.initIgDbEntry(r.game));
                this.updateGameIndex(game);
            });

            console.log(`got ${results.length} results`);

            return [
                results.length > 0, // changed
                gameEntries.some(([, g]) => g.igdbSteamAttempted) // attemptsFailed
            ];
        },
        fetchGameDetailsBatchByTitleAsync: async function () {
            const gameEntries = this.games
                .filter(g => !this.igdb[g.gameId] && !g.igdbTitleAttempted)
                .slice(0, 100)
                .map(g => [g, g.title, g.title.replace(/[\u2122\u00ae]|(\.$)/g, "").trim()]) // remove tm, (r) and trailing period
                .reduce((r, [g, t1, t2]) => {
                    r.push([t1.toLowerCase(), g]);
                    if (t1 !== t2)
                        r.push([t2.toLowerCase(), g]);
                    return r;
                }, []);

            if (gameEntries.length === 0)
                return [false, false];

            console.log(`querying ${gameEntries.length} titles`);
            gameEntries.forEach(([, g]) => g.igdbTitleAttempted = true);

            const gamesByTitle = Object.fromEntries(gameEntries);
            const results = await this.queryIgdb("games", `
                fields name, total_rating, total_rating_count, keywords.name, time_to_beat.*;
                where ${gameEntries.map(([s]) => `name ~ "${s.replace('"', '\\"')}"`).join(" | ")};
                sort total_rating_count desc;
                limit 500;`);

            results.forEach(g => {
                const game = gamesByTitle[g.name.toLowerCase()];
                delete game.igdbTitleAttempted;
                Vue.set(this.igdb, game.gameId, this.initIgDbEntry(g));
                this.updateGameIndex(game);
            });

            console.log(`got ${results.length} results`);

            return [
                results.length > 0, // changed
                gameEntries.some(([, g]) => g.igdbTitleAttempted) // attemptsFailed
            ];
        },
        fetchGameAlternativeTitleAsync: async function (game, title) {
            const results = await this.queryIgdb("games", `
                fields total_rating, total_rating_count, keywords.name, time_to_beat.*;
                where name ~ "${title.replace('"', '\\"')}";
                sort total_rating_count desc;
                limit 1;`);

            if (results.length === 0)
                return false;

            const g = results[0];
            Vue.set(this.igdb, game.gameId, this.initIgDbEntry(g));
            this.updateGameIndex(game);

            return true;
        },
        fetchGameDetailsBatchAsync: async function () {
            let [changed, attemptsFailed] = await this.fetchGameDetailsBatchBySteamIdAsync();
            if (!changed && !attemptsFailed) {
                [changed, attemptsFailed] = await this.fetchGameDetailsBatchByTitleAsync();
            }
            if (!changed && !attemptsFailed) {
                let unknownGame;
                while ((unknownGame = this.games.find(g => !this.igdb[g.gameId] && !g._igdbAltAttempted)) != null) {
                    const response = prompt(
                        `Enter an alternative name for ${unknownGame.title}, leave empty to skip this title until refresh`,
                        unknownGame.title);
                    if (response === "") {
                        unknownGame._igdbAltAttempted = true;
                        continue;
                    } else if (response == null) {
                        break;
                    }
                    changed = await this.fetchGameAlternativeTitleAsync(unknownGame, response) || changed;
                }
            }
            if (changed) {
                this.saveIgdb();
            }
            if (attemptsFailed) {
                this.saveGames(); // failed attempts are bound to game instance
            }
            return changed;
        },
        fetchGameDetailsBatch: function () {
            this.fetchGameDetailsBatchAsync().then(r => console.log(r ? "Data fetched, more may be available." : "No fetch necessary."), console.error);
        }
    }
});
})();
