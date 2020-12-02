const { fetch } = require('fetch-h2');
const {sleep} = require('./utils');
const readini = require('./readini');

const CACHE = new Map();
class ShopifyAPI {
    constructor(auth = {path: "~/.shopify", section: 'default'}) {
        let ini = readini(process.env.SHOPIFY_RC || auth.path, process.env.SHOPIFY_SECTION || auth.section);
        this.auth = Object.assign({
            key: process.env.SHOPIFY_KEY || ini.key,
            password: process.env.SHOPIFY_PASSWORD || ini.password,
            storefront: process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN || ini.storefront,
            host: process.env.SHOPIFY_HOST || ini.host
        }, auth);
    }

    get #key() { return this.auth.key; }
    get #password() { return this.auth.password; }
    get #storefront() { return this.auth.storefront; }
    set #host(val) { this.auth.host = val; }
    get #host() { return this.auth.host; }

    async #get(path = '/', maxTTL = 1) {
        return await this.#request("GET", path, null, maxTTL);
    }

    async #post(path = '/', body = null) {
        return this.#request("POST", path, body);
    }

    async #put(path = '/', body = null) {
        return this.#request("PUT", path, body);
    }

    async #delete(path = '/') {
        return this.#request("DELETE", path);
    }

    async #request(method = "GET", path = '/', body = null, maxTTL = null) {
        if (CACHE.has(method + path) && maxTTL > 0) {
            let cache = CACHE.get(method + path);
            let lastModified = Date.parse(cache.headers.get('last-modified') || cache.headers.get('date') || 0);
            if (lastModified + (maxTTL * 1000) > Date.now()) {
                return cache._body;
            }
            else {
                // to avoid pile-ons, let's use stale cache for 10s
                // TODO: make this work for cache misses too?
                cache.headers.set('last-modified', (new Date(Date.now() + 3 * 1000)).toISOString());
            }
        }

        const headers = {
            'X-Shopify-Storefront-Access-Token': this.#storefront,
            'Authorization': `Basic ${Buffer.from(this.#key + ":" + this.#password).toString("base64")}`,
            'Accept': '*/*',
        };

        const options = {method, headers};
        if (body) {
            options.body = JSON.stringify(body);
            options.headers['Content-Type'] = 'application/json';
        }

        console.info(`${method} ${path}`);
        console.debug(options);
        const urlPrefix = path.startsWith("http") ? '' : `https://${this.#host}`;
        let res = await fetch(`${urlPrefix}${path}`, options)
            .catch(e => {
                console.error(e);
                //TODO: handle network errors more gracefully
                return Promise.reject(e)
            });
        console.debug(res.status + " " + res.statusText);
        console.debug(Object.fromEntries(res.headers.entries()));
        if (res.status >= 500) {
            //TODO: how do we get out of infinite retry?
            console.error(`RETRY: ${method} ${path} (${res.headers.get('status') || res.status + " " + res.statusText})`);
            await sleep(500);
            return await this.#request(method, path, body, maxTTL);
        }
        if (res.status === 429) {
            //TODO: how do we get out of infinite retry?
            console.error(`RETRY: ${method} ${path} (${res.headers.get('status') || res.status + " " + res.statusText})`);
            await sleep(1000);
            return await this.#request(method, path, body, maxTTL);
        }
        else if (res.status >= 400) {
            console.error(`${method} ${path} (${res.headers.get('status') || res.status + " " + res.statusText})`);
            console.error(Object.fromEntries(res.headers));
            throw new Error(`${method} ${path} (${res.headers.get('status') || res.status + " " + res.statusText})`)
        }
        else if (res.status === 302) {
            const [,newHost] = /(?:https?:\/\/)?([^\/]*)\//.exec(res.headers.get('location')) || [];
            this.#host = newHost;
            console.error(`REDIRECT: ${method} ${newHost}${path} (${res.headers.get('status') || res.status + " " + res.statusText})`);
            await sleep(500);
            return await this.#request(method, path, body, maxTTL);
        }
        //TODO: what about other 3xx?
        else if (res.status === 200) {
            if (method === "GET") {
                CACHE.set(method + path, res);
            }
        }

        if (/application\/json/.test(res.headers.get('content-type'))) {
            const json = await res.json();
            res._body = json; // stash it for the cache because .json() isn't re-callable
            console.debug(JSON.stringify(json));
            return json;
        }
        else if (/text/.test(res.headers.get('content-type'))) {
            const txt = await res.text();
            res._body = txt; // stash it for the cache because .json() isn't re-callable
            console.debug(txt);
            return txt;
        }
        return await res.arrayBuffer();
    }

    //
    // Themes https://shopify.dev/docs/admin-api/rest/reference/online-store/theme
    //
    async getThemes() {
        return await this.#get(`/admin/api/2020-10/themes.json`)
    }
    async getTheme(themeID) {
        return await this.#get(`/admin/api/2020-10/themes/${themeID}.json`)
    }
    async createTheme(themeID, src, role="unpublished") {
        const data = {
            theme: {
                id: themeID,
                src: src,
                role: role
            }
        }
        return await this.#post(`/admin/api/2020-10/themes/${themeID}.json`, data)

    }
    async updateTheme(themeID, name = null, role = null) {
        const data = {
            theme: {
                id: themeID
            }
        }
        if (name) data.theme.name = name;
        if (role) data.theme.role = role;
        return await this.#put(`/admin/api/2020-10/themes/${themeID}.json`, data)
    }
    async deleteTheme(themeID) {
        return await this.#delete(`/admin/api/2020-10/themes/${themeID}.json`)
    }

    //
    // Assets https://shopify.dev/docs/admin-api/rest/reference/online-store/theme
    //
    async getAssets(themeID) {
        return await this.#get(`/admin/api/2020-10/themes/${themeID}/assets.json`)
    }

    async getAsset(themeID, key) {
        return await this.#get(`/admin/api/2020-10/themes/${themeID}/assets.json?asset[key]=${key}`);
    }

    //
    // Redirects
    //
    async getRedirects(minRedirectID = 0) {
        return await this.#get(`/admin/api/2020-10/redirects.json?limit=250${minRedirectID >0 ? "&since_id=" + minRedirectID : ""}`)
    }

    async getRedirectsCount() {
        return await this.#get(`/admin/api/2020-10/redirects/count.json`)
    }

    async createRedirect(path, target) {
        const data = {
            redirect: {
                path,
                target
            }
        }
        return await this.#post("/admin/api/2020-10/redirects.json", data);
    }

    async updateRedirect(redirectID, path, target) {
        const data = {
            redirect: {
                id: redirectID
            }
        }
        if (target) data.redirect.target = target;
        if (path) data.redirect.path = path;
        return await this.#put("/admin/api/2020-10/redirects/${redirectID}.json", data);
    }

    async deleteRedirect(redirectID) {
        return await this.#delete("/admin/api/2020-10/redirects/${redirectID}.json");
    }

    //
    // Script Tags
    //

    async getScriptTags(minScriptTagID = 0) {
        return await this.#get(`/admin/api/2020-10/script_tags.json?limit=250${minScriptTagID >0 ? "&since_id=" + minScriptTagID : ""}`)
    }

    async getScriptTagsCount() {
        return await this.#get(`/admin/api/2020-10/script_tags/count.json`)
    }

    async createScriptTags(event="onload", src="https://example.com/script.js") {
        const data = {
            script_tag: { event, src }
        }
        return await this.#post("/admin/api/2020-10/script_tags.json", data);
    }

    async updateScriptTags(scriptTagID, event="onload", src) {
        const data = {
            script_tag: {
                id: scriptTagID,
                event: event
            }
        }
        if (src) data.redirect.src = src;
        return await this.#put("/admin/api/2020-10/script_tags/${scriptTagID}.json", data);
    }

    async deleteScriptTags(redirectID) {
        return await this.#delete("/admin/api/2020-10/script_tags/${scriptTagID}.json");
    }

}

module.exports = ShopifyAPI;
