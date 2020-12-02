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

    async pullAssets(themeName = null, destDir = "./shopify", save = true) {
        const theme = await this.#getThemeID(themeName);
        if (!theme || !theme.id) return [];

        const data = await this.shopifyAPI.getAssets(theme.id);
        if (save) {
            await Promise.all(data.assets.map(async asset => {
                console.info(`SAVING: ${asset.key}`)
                if (asset.public_url) {
                    const res = await fetch(asset.public_url);
                    await this.#saveFile(path.join(destDir, asset.key), Buffer.from(await res.arrayBuffer()));
                }
                else {
                    const detail = await this.shopifyAPI.getAsset(theme.id, asset.key);
                    if (detail && detail.asset && detail.asset.value) {
                        await this.#saveFile(path.join(destDir, asset.key), detail.asset.value);
                    }
                }

            }))
        }
        return data;
    }

    async pullRedirects() {
        const count = await this.shopifyAPI.getRedirectsCount();
        const redirects = [];
        while (redirects.length < count) {
            const maxID = Math.max(0, ...redirects.map(r => r.id));
            redirects.push(await this.shopifyAPI.getRedirects(maxID));
        }
        return redirects;
    }

    async pullScriptTags() {
        const count = await this.shopifyAPI.getScriptTagsCount();
        const scripts = [];
        while (scripts.length < count) {
            const maxID = Math.max(0, ...scripts.map(r => r.id));
            scripts.push(await this.shopifyAPI.getScriptTags(maxID));
        }
        return scripts;
    }
}

module.exports = Shopify;
