const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetch } = require('fetch-h2');
const ShopifyAPI = require('./shopify-api');
const {getFiles, md5File} = require('./utils');

class Shopify {
    constructor(auth) {
        this.shopifyAPI = new ShopifyAPI(auth);
    }

    async #getThemeID(name = null) {
        const res = await this.shopifyAPI.getThemes();

        //TODO: normalize name?
        const theme = res.themes.filter(t => (!name && t.role === 'main') || t.name === name)[0];
        return theme;
    }

    async #saveFile(filename, data) {
        const ensureDirectoryExistence = function (filePath) {
            let dirname = path.dirname(filePath);
            if (fs.existsSync(dirname)) {
                return true;
            }
            ensureDirectoryExistence(dirname);
            fs.mkdirSync(dirname);
        };

        return new Promise((resolve, reject) => {
            ensureDirectoryExistence(filename);
            fs.writeFile(filename, data, error => error ? reject(error) : resolve(data))
        })
    }

    #readFile(filename) {
        return fs.readFileSync(filename, "utf-8");
    }

    async list() {
        return this.shopifyAPI.getThemes();
    }

    async publishTheme(themeName = null) {
        if (!themeName) return;

        const theme = await this.#getThemeID(themeName);
        if (!theme || !theme.id) return;
        if (theme.role !== 'main') return;

        console.log(`PUBLISHING: ${theme.name}`);
        await this.shopifyAPI.updateTheme(theme.id, theme.name, 'main')
    }

    async init(themeName = null) {
        if (!themeName) return;

        const theme = await this.#getThemeID(themeName);
        if (theme || theme.id) return;

        console.log(`CREATE Theme: ${theme.name}`);
        await this.shopifyAPI.createTheme(theme.name, 'unpublished')
    }

    async pullAssets(themeName = null, destDir = "./shopify", save = true, force = false) {
        const theme = await this.#getThemeID(themeName);
        if (!theme || !theme.id) return [];

        const data = await this.shopifyAPI.getAssets(theme.id);
        if (save) {
            await Promise.all(data.assets.map(async asset => {
                const filename = path.join(destDir, asset.key);

                // API optimization
                if (!force && fs.existsSync(filename)) {
                    //skip if the checksums aren't any different from remote and local files
                    if (asset.checksum && asset.checksum === await md5File(filename)) {
                        console.debug(`SKIP: ${filename}`);
                        return;
                    }
                    //skip if the local file has the same byte size and the modified date locally is > the remote update date
                    const stats = fs.statSync(filename);
                    if (stats.size === asset.size && Date.parse(stats.mtime) >= Date.parse(asset.updated_at)) {
                        console.debug(`SKIP: ${filename}`);
                        return;
                    }
                }

                console.log(`SAVING: ${asset.key}`)
                if (asset.public_url) {
                    const res = await fetch(asset.public_url);
                    await this.#saveFile(path.join(destDir, asset.key), Buffer.from(await res.arrayBuffer()));
                }
                else {
                    const detail = await this.shopifyAPI.getAsset(theme.id, asset.key);
                    if (detail && detail.asset && detail.asset.value) {
                        await this.#saveFile(filename, detail.asset.value);
                    }
                }

                //TODO: delete local

            }))
        }
        return data;
    }

    async pushAssets(themeName = null, destDir = "./shopify", force = false) {
        const theme = await this.#getThemeID(themeName);
        if (!theme || !theme.id) return [];

        const data = await this.shopifyAPI.getAssets(theme.id);
        // start with the known set of base dirs to innumerate, but future proof a bit by probing for new dirs
        const knownDirs = new Set(["assets","layout","sections","templates","config","locales","snippets"]);
        data.assets.map(a => a.key.replace(/\/.*/, "")).forEach(knownDirs.add, knownDirs);

        const localFiles = new Set();
        for (const baseDir of knownDirs) {
            for await (const file of getFiles(path.join(destDir, baseDir))) {
                localFiles.add(path.relative(destDir, file));
            }
        }

        const deletePaths = new Set();

        // this loop inspection is opposite the other ones. should iterate over the local files not the remote files
        for (const asset of data.assets) {
            const filename = path.join(destDir, asset.key);

            if (localFiles.has(asset.key)) {
                // API optimization
                if (!force && fs.existsSync(filename)) {
                    //skip if the checksums aren't any different from remote and local files
                    if (asset.checksum && asset.checksum === await md5File(filename)) {
                        localFiles.delete(asset.key);
                        continue;
                    }
                    //skip if the local file has the same byte size and the modified date locally is > the remote update date
                    const stats = fs.statSync(filename);
                    if (stats.size === asset.size && Date.parse(stats.mtime) >= Date.parse(asset.updated_at)) {
                        localFiles.delete(asset.key);
                        continue;
                    }
                }
            }
            else {
                localFiles.delete(asset.key);
                deletePaths.set(asset.key);
            }
        }

        // Create & Updates
        await Promise.all([...localFiles.values()].map(async key => {
            console.log(`UPDATE: ${key}`);
            //TODO: make this work for binary (use attachment)
            const data = this.#readFile(path.join(destDir, key));
            await this.shopifyAPI.updateAsset(theme.id, key, data);
        }));
        // Deletes
        await Promise.all([...deletePaths.values()].map(async key => {
            console.log(`DELETE: ${key}`)
            await this.shopifyAPI.deleteAssets(theme.id, key);
        }));

        return data;
    }

    async getRedirects() {
        let count = null;
        const redirects = [];
        while (count === null || redirects.length < count) {
            const maxID = Math.max(0, ...redirects.map(r => r.id));
            const data = await this.shopifyAPI.getRedirects(maxID);
            redirects.push(...data.redirects);
            if (count === null) count = redirects.length < 250 ? redirects.length : (await this.shopifyAPI.getRedirectsCount()).count;
        }
        return redirects;
    }
    async pullRedirects(destDir = "./shopify") {
        const redirects = await this.getRedirects();
        const filename = path.join(destDir, "redirects.csv");
        const csvData = ["Redirect from,Redirect to"];
        //TODO: .replace(",", "%2C")
        csvData.push(...redirects.map(r => r.path + "," + r.target));
        await this.#saveFile(filename, csvData.join('\n'));
        return redirects;
    }

    async pushRedirects(destDir = "./shopify") {
        const data = await this.getRedirects();
        const originalPaths = new Map(data.map(r => [r.path, r]));

        const updatePaths = new Map();
        const createPaths = new Map();

        const filename = path.join(destDir, "redirects.csv");
        const csvData = this.#readFile(filename).split(/[\n\r]+/);
        csvData.shift();
        for (const line of csvData) {
            if (!line || !line.startsWith('/')) continue; // skip empty lines or the first row;
            const [path, target] = line.split(',');
            if (originalPaths.has(path)) {
                const detail = originalPaths.get(path);
                if (detail.target !== target) {
                    detail.target = target;
                    updatePaths.set(path, detail);
                }
                originalPaths.delete(path);
            }
            else {
                createPaths.set(path, {path, target});
            }
        }

        // Creates
        await Promise.all([...createPaths.values()].map(async r => {
            console.log(`CREATE 302: ${r.path} => ${r.target}`);
            await this.shopifyAPI.createRedirect(r.path, r.target);
        }));
        // Updates
        await Promise.all([...updatePaths.values()].map(async r => {
            console.log(`UPDATE 302: ${r.path} => ${r.target}`);
            await this.shopifyAPI.updateRedirect(r.id, r.path, r.target);
        }));
        // Deletes
        await Promise.all([...originalPaths.values()].map(async r => {
            console.log(`DELETE 302: ${r.path}`);
            await this.shopifyAPI.deleteRedirect(r.id);
        }));
        return csvData;
    }

    async getScriptTags() {
        let count = null;
        const scripts = [];
        while (count === null || scripts.length < count) {
            const maxID = Math.max(0, ...scripts.map(r => r.id));
            const data = await this.shopifyAPI.getScriptTags(maxID)
            scripts.push(...data.script_tags);
            if (count === null) count = scripts.length < 250 ? scripts.length : (await this.shopifyAPI.getScriptTagsCount()).count;
        }
        return scripts;
    }

    async pullScriptTags(destDir = "./shopify") {
        const scripts = await this.getScriptTags();
        const filename = path.join(destDir, "scripts.csv");
        const csvData = ["src,event,scope"];
        //TODO: .replace(",", "%2C")
        csvData.push(...scripts.map(s => s.src + "," + s.event + "," + s.display_scope));
        await this.#saveFile(filename, csvData.join('\n'));
        return scripts;
    }

    async pushScriptTags(destDir = "./shopify") {
        const data = await this.getScriptTags();
        const originalScripts = new Map(data.map(r => [r.src, r]));

        const updateScripts = new Map();
        const createScripts = new Map();

        const filename = path.join(destDir, "scripts.csv");
        const csvData = this.#readFile(filename).split(/[\n\r]+/);
        csvData.shift();
        for (const line of csvData) {
            if (!line || !/\//.test(line)) continue; // skip empty lines or the first row;
            const [src,event,scope] = line.split(',');
            if (originalScripts.has(src)) {
                const detail = originalScripts.get(src);
                if (detail.event !== event || detail.display_scope !== scope) {
                    detail.event = event;
                    detail.display_scope = scope;
                    updateScripts.set(src, detail);
                }
                originalScripts.delete(src);
            }
            else {
                createScripts.set(src, {src: src, event: event, display_scope: scope});
            }
        }

        // Creates
        await Promise.all([...createScripts.values()].map(async s => {
            console.log(`CREATE ScriptTag: ${s.src} ${s.event} (${s.display_scope})`);
            await this.shopifyAPI.createScriptTags(s.src, s.target);
        }));
        // Updates
        await Promise.all([...updateScripts.values()].map(async s => {
            console.log(`UPDATE ScriptTag: ${s.src} ${s.event} (${s.display_scope})`);
            await this.shopifyAPI.updateScriptTags(s.id, s.src, s.event, s.display_scope);
        }));
        // Deletes
        await Promise.all([...originalScripts.values()].map(async s => {
            console.log(`DELETE ScriptTag: ${s.src}`);
            await this.shopifyAPI.deleteScriptTags(s.id);
        }));
        return csvData;
    }
}

module.exports = Shopify;
