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

const data = {
    loading: false,
    games: games || []
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
    methods: {
        loadDbFile: function (ev) {
            data.loading = true;
            const file = ev.dataTransfer.files[0];
            const r = new FileReader();
            r.onload = () => {
                getSqlJs().then(sqlJs => {
                    const db = new sqlJs.Database(new Uint8Array(r.result));
                    importGames(db);
                    data.loading = false;
                });
            }
            r.readAsArrayBuffer(file);
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
        select rp.gameid, ifnull(pc.platform, 'gog') as platform, t.type, p.value
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
            const [gameId, platform, type, json] = stmt.get();
            let game = gamesById[gameId];
            if (!game) {
                game = gamesById[gameId] = processTitles(type, JSON.parse(json));
                game.gameId = gameId;
                game.platforms = new Set([platform]);
                game.primaryPlatform = platform;
            } else {
                game.platforms.add(platform);
                if (game.primaryPlatform === platform) {
                    Object.assign(game, processTitles(type, JSON.parse(json)));
                }
            }
        }
    } finally {
        stmt.free();
    }
    const games = Object.values(gamesById)
        .filter(g => g.verticalCover) // games without verticalCover are not visible in galaxy either
        .sort((a, b) => (a.sortingTitle || a.title).localeCompare(b.sortingTitle || b.title));
    games.forEach(g => {
        g.platforms = Array.from(g.platforms.values()).sort(); // Set to Array
    });
    try {
        localStorage.ggdb_games = LZString.compressToUTF16(JSON.stringify(games));
    } catch (err) {
        console.error("Failed to write games to localStorage");
        console.error(err);
        localStorage.removeItem("ggdb_games");
    }
    data.games = games;
}
})();
