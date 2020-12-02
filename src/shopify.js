const fs = require('fs');
const path = require('path');
const { fetch } = require('fetch-h2');
const ShopifyAPI = require('./shopify-api');

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


    async list() {
        return this.shopifyAPI.getThemes();
    }

    async pullAssets(themeName = null, destDir = "./shopify", save = true, force = false) {
        const theme = await this.#getThemeID(themeName);
        if (!theme || !theme.id) return [];

        const data = await this.shopifyAPI.getAssets(theme.id);
        if (save) {
            await Promise.all(data.assets.map(async asset => {
                const filename = path.join(destDir, asset.key);

                if (!force && fs.existsSync(filename)) {
                    const stats = fs.statSync(filename);
                    if (stats.size === asset.size) {
                        if (Date.parse(stats.mtime) >= Date.parse(asset.updated_at)) {
                            console.info(`SKIP: ${filename}`);
                            return;
                        }
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

            }))
        }
        return data;
    }

    async pullRedirects(destDir = "./shopify") {
        const count = (await this.shopifyAPI.getRedirectsCount()).count || 0;
        const redirects = [];
        while (redirects.length < count) {
            const maxID = Math.max(0, ...redirects.map(r => r.id));
            const data = await this.shopifyAPI.getRedirects(maxID);
            redirects.push(...data.redirects);
        }
        const filename = path.join(destDir, "redirects.csv");
        const csvData = ["Redirect from,Redirect to"];
        //TODO: .replace(",", "%2C")
        csvData.push(...redirects.map(r => r.path + "," + r.target));
        await this.#saveFile(filename, csvData.join('\n'));
        return redirects;
    }

    async pullScriptTags(destDir = "./shopify") {
        const count = (await this.shopifyAPI.getScriptTagsCount()).count || 0;
        const scripts = [];
        while (scripts.length < count) {
            const maxID = Math.max(0, ...scripts.map(r => r.id));
            const data = await this.shopifyAPI.getScriptTags(maxID)
            scripts.push(...data.scripts);
        }
        const filename = path.join(destDir, "scripts.csv");
        const csvData = ["src,event,scope"];
        //TODO: .replace(",", "%2C")
        csvData.push(...scripts.map(s => s.src + "," + s.event, + ",", s.scope));
        await this.#saveFile(filename, csvData);
        return scripts;
    }
}

module.exports = Shopify;
