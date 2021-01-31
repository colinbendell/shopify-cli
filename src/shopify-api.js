const { fetch } = require('fetch-h2');
const {sleep} = require('./utils');
const readini = require('./readini');

const CACHE = new Map();
const API_VERSION = "2021-01";
class ShopifyAPI {
    constructor(auth = {path: "~/.shopify", section: 'default'}) {
        let ini = readini(process.env.SHOPIFY_RC || auth.path, process.env.SHOPIFY_SECTION || auth.section);
        this.auth = Object.assign({
            password: process.env.SHOPIFY_PASSWORD || ini.password,
            storefront: process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN || ini.storefront,
            host: process.env.SHOPIFY_HOST || ini.host
        }, auth);
    }

    get #password() { return this.auth.password; }
    get #storefront() { return this.auth.storefront; }
    set #host(val) { this.auth.host = val; }
    get host() { return this.auth.host; }

    async #get(path = '/', maxTTL = 300) {
        return this.#request("GET", path, null, maxTTL);
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
            let lastModified = Date.parse(cache.headers.get('date') || cache.headers.get('last-modified') || 0);
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
            // leaving these here to show how nonsensical our APIs are
            'X-Shopify-Access-Token': this.#password,
            'X-Shopify-Storefront-Access-Token': this.#storefront,
            // 'Authorization': `Basic ${Buffer.from(this.#key + ":" + this.#password).toString("base64")}`,
            'Accept': 'application/json, text/javascript, */*; q=0.01',
        };
        if (process.env.SHOPIFY_ADMIN_COOKIE) {
            delete headers['X-Shopify-Access-Token'];
            delete headers['X-Shopify-Storefront-Access-Token'];
            headers['x-requested-with'] = 'XMLHttpRequest';
            headers['user-agent'] = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36';
            headers['sec-fetch-site'] = 'same-origin';
            headers['sec-fetch-mode'] = 'cors';
            headers['sec-fetch-dest'] = 'empty';
            headers['accept-language'] = 'en-US,en;q=0.9,pl;q=0.8';
            headers['cookie'] = process.env.SHOPIFY_ADMIN_COOKIE;
        }

        const options = {method, headers, allowForbiddenHeaders: true};
        if (body) {
            options.body = JSON.stringify(body);
            options.headers['Content-Type'] = 'application/json';
        }

        console.info(`${method} ${path}`);
        console.debug(options);
        const urlPrefix = path.startsWith("http") ? '' : `https://${this.host}`;
        let res = await fetch(`${urlPrefix}${path}`, options)
            .catch(e => {
                console.error(e);
                //TODO: handle network errors more gracefully
                return Promise.reject(e)
            });
        console.debug(res.status + " " + res.statusText);
        console.debug(Object.fromEntries(res.headers.entries()));

        // need to consume the body so that the stream is completed and not left dangling.
        if (/application\/json/.test(res.headers.get('content-type'))) {
            const json = await res.json();
            res._body = json; // stash it for the cache because .json() isn't re-callable
            console.debug(JSON.stringify(json));
        }
        else if (/text/.test(res.headers.get('content-type'))) {
            const txt = await res.text();
            res._body = txt; // stash it for the cache because .json() isn't re-callable
            console.debug(txt);
        }
        else {
            //TODO: what happens if the buffer isn't fully consumed?
            res._body = Buffer.from(await res.arrayBuffer());
        }

        if (res.status === 429 || res.status >= 500) {
            //TODO: how do we get out of infinite retry?
            const retryTime = res?.headers?.get('retry-after')*1000 || 1000; // default 1s retry time
            const statusLine = res.headers.get('status') || res.status + " " + res.statusText;
            console.error(`RETRY ${retryTime/1000}s: ${method} ${path} (${statusLine.trim()})`);
            await sleep(Math.min(retryTime, 10 * 1000)); // don't let the retry time exceed 10s
            return await this.#request(method, path, body, maxTTL);
        }
        else if (res.status === 404) {
            return null;
        }
        else if (res.status >= 400) {
            console.error(`${method} ${path} (${res.headers.get('status') || res.status + " " + res.statusText})`);
            if (res.headers.get('content-length') > 0) console.error(await res.text());
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

        if (method !== "GET") {
            CACHE.delete("GET" + path);
        }

        return res._body;
    }

    async getURL(path = '/', maxTTL = 300) {
        return this.#get(path, maxTTL);
    }

    //
    // Themes https://shopify.dev/docs/admin-api/rest/reference/online-store/theme
    //
    async getThemes() {
        return await this.#get(`/admin/api/${API_VERSION}/themes.json`)
    }
    async getTheme(themeID) {
        return await this.#get(`/admin/api/${API_VERSION}/themes/${themeID}.json`)
    }
    async createTheme(name, role="unpublished", src = null) {
        const data = {
            theme: {name, role}
        }
        if (src) data.theme.src = src;

        return await this.#post(`/admin/api/${API_VERSION}/themes.json`, data);

    }
    async updateTheme(themeID, name = null, role = null) {
        const data = {
            theme: {
                id: themeID
            }
        }
        if (name) data.theme.name = name;
        if (role) data.theme.role = role;
        return await this.#put(`/admin/api/${API_VERSION}/themes/${themeID}.json`, data)
    }
    async deleteTheme(themeID) {
        return await this.#delete(`/admin/api/${API_VERSION}/themes/${themeID}.json`)
    }

    //
    // Assets https://shopify.dev/docs/admin-api/rest/reference/online-store/theme
    //
    async getAssets(themeID) {
        return await this.#get(`/admin/api/${API_VERSION}/themes/${themeID}/assets.json`)
    }

    async getAsset(themeID, key, version) {
        return await this.#get(`/admin/api/${API_VERSION}/themes/${themeID}/assets.json?asset[key]=${key}${ version ? "&asset[version]=" + version : ""}`);
    }

    async getAssetVersions(themeID, key) {
        return await this.#get(`/admin/api/${API_VERSION}/themes/${themeID}/assets/versions?asset[key]=${key}`);
    }

    async updateAsset(themeID, key, value, attachment) {
        const data = {
            asset: { key }
        }
        if (value) data.asset.value = value;
        if (attachment) data.asset.attachment = attachment;

        return await this.#put(`/admin/api/${API_VERSION}/themes/${themeID}/assets.json`, data);
    }

    async deleteAsset(themeID, key) {
        return await this.#delete(`/admin/api/${API_VERSION}/themes/${themeID}/assets.json?asset[key]=${key}`);
    }


    //
    // Redirects
    //
    async getRedirects(minRedirectID = 0) {
        return await this.#get(`/admin/api/${API_VERSION}/redirects.json?limit=250${minRedirectID >0 ? "&since_id=" + minRedirectID : ""}`)
    }

    async getRedirectsCount() {
        return await this.#get(`/admin/api/${API_VERSION}/redirects/count.json`)
    }

    async createRedirect(path, target) {
        const data = {
            redirect: {
                path: path,
                target: target
            }
        }
        return await this.#post(`/admin/api/${API_VERSION}/redirects.json`, data);
    }

    async updateRedirect(redirectID, path, target) {
        const data = {
            redirect: {
                id: redirectID
            }
        }
        if (target) data.redirect.target = target;
        if (path) data.redirect.path = path;
        return await this.#put(`/admin/api/${API_VERSION}/redirects/${redirectID}.json`, data);
    }

    async deleteRedirect(redirectID) {
        return await this.#delete(`/admin/api/${API_VERSION}/redirects/${redirectID}.json`);
    }

    //
    // Script Tags
    //

    async getScriptTags(minScriptTagID = 0) {
        return await this.#get(`/admin/api/${API_VERSION}/script_tags.json?limit=250${minScriptTagID >0 ? "&since_id=" + minScriptTagID : ""}`)
    }

    async getScriptTagsCount() {
        return await this.#get(`/admin/api/${API_VERSION}/script_tags/count.json`)
    }

    async createScriptTags(src="https://example.com/script.js", event="onload") {
        const data = {
            script_tag: { event, src }
        }
        return await this.#post(`/admin/api/${API_VERSION}/script_tags.json`, data);
    }

    async updateScriptTags(scriptTagID, src, event="onload") {
        const data = {
            script_tag: {
                id: scriptTagID,
                event: event
            }
        }
        if (src) data.redirect.src = src;
        return await this.#put(`/admin/api/${API_VERSION}/script_tags/${scriptTagID}.json`, data);
    }

    async deleteScriptTags(scriptTagID) {
        return await this.#delete(`/admin/api/${API_VERSION}/script_tags/${scriptTagID}.json`);
    }

    //
    // Pages
    //

    async getPages(minPageID = 0) {
        return await this.#get(`/admin/api/${API_VERSION}/pages.json?limit=250${minPageID >0 ? "&since_id=" + minPageID : ""}`)
    }

    async getPagesCount() {
        return await this.#get(`/admin/api/${API_VERSION}/pages/count.json`)
    }

    async getPage(pageID) {
        return await this.#get(`/admin/api/${API_VERSION}/pages/${pageID}.json`);
    }

    async createPage(page) {
        return await this.#post(`/admin/api/${API_VERSION}/pages.json`, {page});
    }

    async updatePage(pageID, page) {
        return await this.#put(`/admin/api/${API_VERSION}/pages/${pageID}.json`, {page});
    }
    async deletePage(pageID) {
        return await this.#delete(`/admin/api/${API_VERSION}/pages/${pageID}.json`);
    }

    //
    // Blogs
    //

    async getBlogs(minBlogID = 0) {
        return await this.#get(`/admin/api/${API_VERSION}/blogs.json?limit=250${minBlogID >0 ? "&since_id=" + minBlogID : ""}`)
    }

    async getBlogsCount() {
        return await this.#get(`/admin/api/${API_VERSION}/blogs/count.json`)
    }

    async getBlog(blogID) {
        return await this.#get(`/admin/api/${API_VERSION}/blogs/${blogID}.json`);
    }

    async createBlog(blog) {
        return await this.#post(`/admin/api/${API_VERSION}/blogs.json`, {blog});
    }

    async updateBlog(blogID, blog) {
        return await this.#put(`/admin/api/${API_VERSION}/blogs/${blogID}.json`, {blog});
    }
    async deleteBlog(blogID) {
        return await this.#delete(`/admin/api/${API_VERSION}/blogs/${blogID}.json`);
    }

    //
    // BlogArticles
    //

    async getBlogArticles(blogID, minBlogArticleID = 0) {
        return await this.#get(`/admin/api/${API_VERSION}/blogs/${blogID}/articles.json?limit=250${minBlogArticleID >0 ? "&since_id=" + minBlogArticleID : ""}`)
    }

    async getBlogArticlesCount(blogID) {
        return await this.#get(`/admin/api/${API_VERSION}/blogs/${blogID}/articles/count.json`)
    }

    async getBlogArticle(blogID, blogArticleID) {
        return await this.#get(`/admin/api/${API_VERSION}/blogs/${blogID}/articles/${blogArticleID}.json`);
    }

    async createBlogArticle(blogID, article) {
        return await this.#post(`/admin/api/${API_VERSION}/blogs/${blogID}/articles.json`, {article});
    }

    async updateBlogArticle(blogID, blogArticleID, article) {
        return await this.#put(`/admin/api/${API_VERSION}/blogs/${blogID}/articles/${blogArticleID}.json`, {article});
    }
    async deleteBlogArticle(blogID, blogArticleID) {
        return await this.#delete(`/admin/api/${API_VERSION}/blogs/${blogID}/articles/${blogArticleID}.json`);
    }

    //
    // Menus
    //

    async getMenus(minMenuID = 0) {
        return await this.#get(`/admin/api/${API_VERSION}/menus.json?limit=250${minMenuID >0 ? "&since_id=" + minMenuID : ""}`)
    }

    async getMenusCount() {
        return await this.#get(`/admin/api/${API_VERSION}/menus/count.json`)
    }

    async getMenu(menuID) {
        return await this.#get(`/admin/api/${API_VERSION}/menus/${menuID}.json`);
    }

    async createMenu(menu) {
        return await this.#post(`/admin/api/${API_VERSION}/menus.json`, {menu});
    }

    async updateMenu(menuID, menu) {
        return await this.#put(`/admin/api/${API_VERSION}/menus/${menuID}.json`, {menu});
    }
    async deleteMenu(menuID) {
        return await this.#delete(`/admin/api/${API_VERSION}/menus/${menuID}.json`);
    }

    //
    // Products
    //

    async getProducts(minProductID) {
        return await this.#get(`/admin/api/${API_VERSION}/products.json?limit=250${minProductID >0 ? "&since_id=" + minProductID : ""}`);
    }

    async getProductsCount() {
        return await this.#get(`/admin/api/${API_VERSION}/products/count.json`);
    }

    async getProduct(productID) {
        return await this.#get(`/admin/api/${API_VERSION}/products/${productID}.json`);
    }

    async createProduct(product) {
        return await this.#post(`/admin/api/${API_VERSION}/products.json`, {product});
    }

    async updateProduct(productID, product) {
        return await this.#put(`/admin/api/${API_VERSION}/products/${productID}.json`, {product});
    }
    async deleteProduct(productID) {
        return await this.#delete(`/admin/api/${API_VERSION}/products/${productID}.json`);
    }

    //
    // ProductImages
    //

    async getProductImages(productID, minImageID) {
        return await this.#get(`/admin/api/${API_VERSION}/products/${productID}/images.json?limit=250${minImageID >0 ? "&since_id=" + minImageID : ""}`);
    }

    async getProductImagesCount(productID) {
        return await this.#get(`/admin/api/${API_VERSION}/products/${productID}/images/count.json`);
    }

    async getProductImage(productID, imageID) {
        return await this.#get(`/admin/api/${API_VERSION}/products/${productID}/images/${imageID}.json`);
    }

    async createProductImage(productID, image) {
        return await this.#post(`/admin/api/${API_VERSION}/products/${productID}/images.json`, {image});
    }

    async updateProductImage(productID, imageID, productImage) {
        return await this.#put(`/admin/api/${API_VERSION}/products/${productID}/images/${imageID}.json`, {productImage});
    }
    async deleteProductImage(productImageID) {
        return await this.#delete(`/admin/api/${API_VERSION}/productImages/${productImageID}.json`);
    }
}

module.exports = ShopifyAPI;
