(() => {
const cachedGames = localStorage.ggdb_games;
let games = null;
if (cachedGames) {
    try {
        const gamesJson = LZString.decompressFromUTF16(cachedGames);
        if (!gamesJson)
            throw new Error("Failed to decompress content");
        games = JSON.parse(gamesJson);
    } catch (err) {
        console.error("Error parsing games from localStorage");
        console.error(err);
        localStorage.removeItem("ggdb_games");
    }
}

let sqlJsPromise;
function getSqlJs() {
    return sqlJsPromise || (sqlJsPromise = initSqlJs({
        locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.3.0/dist/${file}`
    }));
}

function initGames(games) {
    games && games.forEach(g => {
        g.textIndex = [g.title, ...g.genres, ...g.themes, g.summary].join("\t").toLowerCase();
    });
    return games;
}

const data = {
    loading: false,
    games: initGames(games) || [],
    hiddenPlatforms: {},
    filter: ""
};

Vue.component("game-view", {
    props: ["game"],
    template: "#gameViewTemplate",
    methods: {
        showDetails: game => console.log(JSON.parse(JSON.stringify(game)))
    }
});

new Vue({
    el: "#app",
    data: data,
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
    methods: {
        loadDbFile: function (ev) {
            data.loading = true;
            const file = ev.dataTransfer.files[0];
            const r = new FileReader();
            r.onload = () => {
                getSqlJs().then(sqlJs => {
                    setTimeout(() => {
                        // in a timeout to ensure loading text is visible
                        const db = new sqlJs.Database(new Uint8Array(r.result));
                        importGames(db);
                        data.loading = false;
                    });
                });
            };
            r.readAsArrayBuffer(file);
        },
        togglePlatform: function (plat) {
            Vue.set(data.hiddenPlatforms, plat, !data.hiddenPlatforms[plat]);
        },
        isGameVisible: function(game) {
            if (!game.platforms.some(p => !this.hiddenPlatforms[p]))
                return false;
            if (this.filterTokens)
                return this.filterTokens.every(filter => game.textIndex.indexOf(filter) !== -1);
            return true;
        }
    }
});

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
function importGames(db) {
    const stmt = db.prepare(`
        select rp.gameid, p.releasekey, ifnull(pc.platform, 'gog') as platform, t.type, p.value
        from GamePieces p
        join ReleaseProperties rp on p.releasekey = rp.releasekey
            and isvisibleinlibrary = 1
        join GamePieceTypes t on p.gamePieceTypeId = t.id
        left join PlatformConnections pc on p.releasekey like pc.platform || '_%'
            and pc.connectionstate = 'Connected'
        where pc.platform is not null or p.releasekey like 'gog_%';`);
    const gamesById = {};
    try {
        while (stmt.step()) {
            const [gameId, releaseKey, platform, type, json] = stmt.get();
            const game = gamesById[gameId] || (gamesById[gameId] = { gameId });
            const release = game[releaseKey] || (game[releaseKey] = { platform, releaseKey });
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
            return sortedReleases.length ? { ...sortedReleases[0], otherPlatforms: sortedReleases.slice(1) } : null;
        })
        .filter(r => r)
        .sort((a, b) => (a.sortingTitle || a.title).localeCompare(b.sortingTitle || b.title));
    games.forEach(g => {
        const plats = new Set(g.otherPlatforms.map(r => r.platform));
        plats.add(g.platform);
        g.platforms = Array.from(plats.values()).sort();
    });
    try {
        localStorage.ggdb_games = LZString.compressToUTF16(JSON.stringify(games));
    } catch (err) {
        console.error("Failed to write games to localStorage");
        console.error(err);
        localStorage.removeItem("ggdb_games");
    }
    data.games = initGames(games);
}
})();
