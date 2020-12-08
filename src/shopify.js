const fs = require('fs');
const path = require('path');
const { fetch } = require('fetch-h2');
const ShopifyAPI = require('./shopify-api');
const {getFiles, globAsRegex, md5File, md5, cleanObject, isSame} = require('./utils');
const { stringify } = require('./stringify');

const PAGES_OBJECT_CLEANUP = ["id", "handle", "shop_id", "admin_graphql_api_id"];
const PAGES_OBJECT_CLEANUP_EXT = [...PAGES_OBJECT_CLEANUP, "published_at", "created_at", "updated_at", "deleted_at"];

class Shopify {
    constructor(auth) {
        this.shopifyAPI = new ShopifyAPI(auth);
    }

    async #getThemeID(name = null) {
        const res = await this.shopifyAPI.getThemes();

        //TODO: normalize name?
        return res.themes.filter(t => (!name && t.role === 'main') || t.name === name)[0];
    }

    #ignoreFiles = new Map();
    #matchesShopifyIgnore(baseDir, file) {
        if (!this.#ignoreFiles.has(baseDir)) {

            const ignore = this.#readFile(path.join(baseDir, ".shopifyignore")) || "";

            this.#ignoreFiles.set(baseDir, ignore.split(/(\n\r)+/m)
                .map(l => l.trim())
                .filter(l => !!l)
                .filter(l => !l.startsWith("#"))
                .map(l => globAsRegex(l)));
        }
        if (this.#ignoreFiles.get(baseDir).length === 0) return false;
        for (const ignoreRegex of this.#ignoreFiles.get(baseDir)) {
            if (ignoreRegex.test(file)) {
                return true;
            }
        }
        return false;
    }

    async getLocalFiles(baseDir = ".", scanDirs = [], filterRegex = null) {
        const localFiles = new Set();
        for (const subDir of scanDirs) {
            for await (const file of getFiles(path.join(baseDir, subDir))) {
                const relativeFile = path.relative(baseDir, file);
                if (filterRegex && filterRegex.test(relativeFile)) continue;
                if (!this.#matchesShopifyIgnore(baseDir, file)) {
                    localFiles.add(relativeFile);
                }
            }
        }
        return localFiles;
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
        if (!fs.existsSync(filename)) return;
        if (/(txt|htm|html|csv|svg|json|js|liquid|css|scss|)$/.test(filename)) {
            return fs.readFileSync(filename, "utf-8");
        }
        return fs.readFileSync(filename, "binary");
    }

    async list() {
        return this.shopifyAPI.getThemes();
    }

    async publishTheme(themeName) {
        if (!themeName) return;

        const theme = await this.#getThemeID(themeName);
        if (!theme || !theme.id) return;
        if (theme.role !== 'main') return;

        console.log(`PUBLISHING: ${theme.name}`);
        await this.shopifyAPI.updateTheme(theme.id, theme.name, 'main')
    }

    async initTheme(themeName, src = null) {
        if (!themeName) return;

        const theme = await this.#getThemeID(themeName);
        if (theme) return;

        console.log(`CREATE Theme: ${themeName}`);
        await this.shopifyAPI.createTheme(themeName, 'unpublished', src)
    }

    async #getAssets(themeID) {
        const data = await this.shopifyAPI.getAssets(themeID)
        const assetsMap = new Map(data.assets.map(a => [a.key, a]));
        for (const key of assetsMap.keys()) {
            if (assetsMap.has(key + ".liquid")) {
                assetsMap.delete(key);
            }
        }
        return [...assetsMap.values()];
    }

    async #isAssetSame(localFilename, remoteCheckSum, remoteLastModified, remoteSize) {
        if (!fs.existsSync(localFilename)) return false;

        //skip if the checksums aren't any different from remote and local files
        if (remoteCheckSum && remoteCheckSum === await md5File(localFilename)) {
            return true;
        }
        //skip if the local file has the same byte size and the modified date locally is > the remote update date
        const stats = fs.statSync(localFilename);
        let localSize = stats.size;
        let localLastModified = stats.mtime.getTime();
        if (/.json/.test(localFilename)) {
            const normalizedJSON = JSON.stringify(JSON.parse(this.#readFile(localFilename))).replace(/\//g, "\\/");
            localSize = normalizedJSON.length;
        }

        if (localSize === remoteSize && localLastModified + 5*60*1000 >= Date.parse(remoteLastModified)) {
            return true;
        }
        return false;
    }

    async pullAssets(themeName = null, destDir = "./shopify", force = false, dryrun=false) {
        const theme = await this.#getThemeID(themeName);
        if (!theme || !theme.id) return [];

        const remoteAssets = await this.#getAssets(theme.id);
        // start with the known set of base dirs to innumerate, but future proof a bit by probing for new dirs
        const knownDirs = new Set(["assets","layout","sections","templates","config","locales","snippets"]);
        remoteAssets.map(a => a.key.replace(/\/.*/, "")).forEach(knownDirs.add, knownDirs);

        const localFiles = await this.getLocalFiles(destDir, [...knownDirs]);

        await Promise.all(remoteAssets.map(async asset => {
            const filename = path.join(destDir, asset.key);
            localFiles.delete(asset.key);

            // API optimization
            if (!force && await this.#isAssetSame(filename, asset.checksum, asset.updated_at, asset.size)) {
                console.debug(`SKIP: ${filename}`);
                return;
            }

            console.log(`SAVING: ${asset.key}`)
            if (dryrun) {
                //no-op
            }
            else if (asset.public_url) {
                const res = await fetch(asset.public_url);
                await this.#saveFile(path.join(destDir, asset.key), Buffer.from(await res.arrayBuffer()));
            }
            else {
                const detail = await this.shopifyAPI.getAsset(theme.id, asset.key);
                if (detail && detail.asset && detail.asset.value) {
                    let data = detail.asset.value;
                    if (detail.asset.key.endsWith("json")) {
                        console.log(`${asset.key} - ${require('crypto').createHash('md5').update(JSON.stringify(JSON.parse(detail.asset.value))).digest('hex')}`)
                        data = stringify(JSON.parse(data));
                    }

                    await this.#saveFile(filename, data);
                }
            }

        }))

        for (const f of localFiles) {
            console.log(`DELETE ${f}`);
            if (!dryrun) fs.unlinkSync(path.join(destDir, f));
        }
        return remoteAssets;
    }

    async pushAssets(themeName = null, destDir = "./shopify", force = false) {
        const theme = await this.#getThemeID(themeName);
        if (!theme || !theme.id) return [];

        const remoteAssets = await this.#getAssets(theme.id);
        // start with the known set of base dirs to innumerate, but future proof a bit by probing for new dirs
        const knownDirs = new Set(["assets","layout","sections","templates","config","locales","snippets"]);
        remoteAssets.map(a => a.key.replace(/\/.*/, "")).forEach(knownDirs.add, knownDirs);

        const localFiles = await this.getLocalFiles(destDir, knownDirs);

        const deletePaths = new Set();

        // this loop inspection is opposite the other ones. should iterate over the local files not the remote files
        for (const asset of remoteAssets) {
            const filename = path.join(destDir, asset.key);

            if (localFiles.has(asset.key)) {
                // API optimization
                if (!force && await this.#isAssetSame(filename, asset.checksum, asset.updated_at, asset.size)) {
                    localFiles.delete(asset.key);
                }
            }
            else {
                localFiles.delete(asset.key);
                deletePaths.add(asset.key);
            }
        }

        // Create & Updates
        await Promise.all([...localFiles.values()].map(async key => {
            console.log(`UPDATE: ${key}`);
            //TODO: make this work for binary (use attachment)
            const data = this.#readFile(path.join(destDir, key));
            const stringValue = typeof data === "string" ? data : null;
            const attachmentValue = typeof data !== "string" ? Buffer.from(data).toString("base64") : null;
            await this.shopifyAPI.updateAsset(theme.id, key, stringValue, attachmentValue);
        }));
        // Deletes
        await Promise.all([...deletePaths.values()].map(async key => {
            console.log(`DELETE: ${key}`)
            await this.shopifyAPI.deleteAsset(theme.id, key);
        }));

        return remoteAssets;
    }

    async getRedirects() {
        let count = null;
        const redirects = [];
        while (count === null || redirects.length < count) {
            const maxID = Math.max(0, ...redirects.map(r => r.id));
            const data = await this.shopifyAPI.getRedirects(maxID);
            redirects.push(...data.redirects);
            if (count === null) {
                count = redirects.length < 250 ? redirects.length : (await this.shopifyAPI.getRedirectsCount()).count;
            }
        }
        return redirects;
    }
    async pullRedirects(destDir = "./shopify") {
        const redirects = await this.getRedirects();
        const filename = path.join(destDir, "redirects.csv");
        const csvData = ["Redirect from,Redirect to"];
        //TODO: .replace(",", "%2C")
        csvData.push(...redirects.map(r => r.path + "," + r.target));
        if (await md5File(filename) !== md5(csvData.join('\n'))) {
            console.log(`SAVING: redirects.csv`);
            await this.#saveFile(filename, csvData.join('\n'));
        }
        return redirects;
    }
    async pushRedirects(destDir = "./shopify") {
        const data = await this.getRedirects();
        const originalPaths = new Map(data.map(r => [r.path, r]));

        const updatePaths = new Map();
        const createPaths = new Map();

        const filename = path.join(destDir, "redirects.csv");
        const localCSV = (this.#readFile(filename) || "").split(/[\n\r]+/);
        localCSV.shift();
        for (const line of localCSV) {
            if (!line || !line.startsWith('/')) continue; // skip empty lines or the first row;
            const [path, target] = line.split(',');
            if (!path || !target) continue;

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
        return localCSV;
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
        if (await md5File(filename) !== md5(csvData.join('\n'))) {
            console.log(`SAVING: scripts.csv`);
            await this.#saveFile(filename, csvData.join('\n'));
        }
        return scripts;
    }
    async pushScriptTags(destDir = "./shopify") {
        const data = await this.getScriptTags();
        const originalScripts = new Map(data.map(r => [r.src, r]));

        const updateScripts = new Map();
        const createScripts = new Map();

        const filename = path.join(destDir, "scripts.csv");
        const localCSV = (this.#readFile(filename) || "").split(/[\n\r]+/);
        localCSV.shift();
        for (const line of localCSV) {
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
        return localCSV;
    }

    async getPages() {
        let count = null;
        const pages = [];
        while (count === null || pages.length < count) {
            const maxID = Math.max(0, ...pages.map(r => r.id));
            const data = await this.shopifyAPI.getPages(maxID)
            pages.push(...data.pages);
            if (count === null) count = pages.length < 250 ? pages.length : (await this.shopifyAPI.getPagesCount()).count;
        }
        return pages;
    }

    async pullPages(destDir = "./shopify") {
        const pagesDir = path.join(destDir, "pages");
        const pagesDraftDir = path.join(pagesDir, "drafts");

        const remotePages = await this.getPages();
        console.log(`SAVING: pages/*`)

        const localFiles = new Set([...await this.getLocalFiles(destDir, "pages")].map(file => path.relative("pages", file)));

        for (const page of remotePages) {
            const handle = page.handle;
            const html = page.body_html;
            const filename = path.join(page.published_at ? pagesDir : pagesDraftDir, handle);
            cleanObject(page, PAGES_OBJECT_CLEANUP);
            page.body_html = {file: `${handle}.html`};

            console.info(`SAVING: ${page.published_at ? "" : "drafts/"}${handle}.html`);
            await this.#saveFile(filename + ".json", JSON.stringify(page, null, 2));
            await this.#saveFile(filename + ".html", html);
            localFiles.delete(path.relative(pagesDir, filename) + ".json");
            localFiles.delete(path.relative(pagesDir, filename) + ".html");
        }

        for (const f of localFiles) {
            console.log(`DELETE ${f}`);
            fs.unlinkSync(path.join(destDir, f));
        }
    }

    async pushPages(destDir = "./shopify") {
        const pagesDir = path.join(destDir, "pages");
        const pagesDraftDir = path.join(pagesDir, "drafts");

        const remotePages = await this.getPages();
        const readPageFile = (file) => {
            if (!fs.existsSync(file)) return;
            const d = this.#readFile(file);
            const data = JSON.parse(d);
            if (data.body_html && data.body_html.file) {
                data.body_html = this.#readFile(path.join(path.dirname(file), data.body_html.file));
            }
            return data;
        }

        const localFiles = new Set();
        for await (const file of getFiles(pagesDir)) {
            if (!file.endsWith(".json")) continue; // only look for the .json files (implying the .html files)
            localFiles.add(path.relative(pagesDir, file).replace(/\.json$/,""));
        }

        const updatePage = new Set();
        const deletePages = new Set();

        for (const page of remotePages) {
            const handle = page.handle;
            const draftHandle = path.join("drafts", handle);

            if (localFiles.has(handle) || localFiles.has(draftHandle)) {
                const detail = readPageFile(path.join(pagesDir, handle + ".json")) || readPageFile(path.join(pagesDraftDir, handle + ".json"));

                //if the file exists in both drafts and published, we bias to the published entry
                detail.published = !localFiles.has(draftHandle) || localFiles.has(handle);
                if (!detail.published) delete detail.published_at; // not enough just to say it is not published
                detail.handle = handle;
                detail.id = page.id;
                page.published = (!!page.published_at);

                if (!isSame(page, detail, PAGES_OBJECT_CLEANUP_EXT)) {
                    updatePage.add(detail);
                }
                localFiles.delete(handle);
                localFiles.delete(draftHandle);
            }
            else {
                deletePages.add(page);
            }
        }
        // Creates
        await Promise.all([...localFiles].map(async file => {
            const page = readPageFile(path.join(pagesDir, file + ".json"));
            //cleanup properties that might have been cloned
            delete page.id;
            if (!page.published) delete page.published_at;
            page.published = file.startsWith("drafts");
            page.handle = file.replace("drafts/", "");

            console.log(`CREATE pages/${file}`);
            await this.shopifyAPI.createPage(page);
        }));
        // Updates
        await Promise.all([...updatePage].map(async file => {
            console.log(`UPDATE pages/${file.handle})`);
            await this.shopifyAPI.updatePage(file.id, file);
        }));
        // Deletes
        await Promise.all([...deletePages].map(async file => {
            console.log(`DELETE pages/${file.handle}`);
            await this.shopifyAPI.deletePage(file.id);
        }));
    }

    //
    // Blogs
    //
    async getBlogs() {
        let count = null;
        const blogs = [];
        while (count === null || blogs.length < count) {
            const maxID = Math.max(0, ...blogs.map(r => r.id));
            const data = await this.shopifyAPI.getBlogs(maxID)
            blogs.push(...data.blogs);
            if (count === null) count = blogs.length < 250 ? blogs.length : (await this.shopifyAPI.getBlogsCount()).count;
        }
        return blogs;
    }
    async getBlogArticles(blogID) {
        let count = null;
        const blogArticles = [];
        while (count === null || blogArticles.length < count) {
            const maxID = Math.max(0, ...blogArticles.map(r => r.id));
            const data = await this.shopifyAPI.getBlogArticles(blogID, maxID)
            blogArticles.push(...data.articles);
            if (count === null) count = blogArticles.length < 250 ? blogArticles.length : (await this.shopifyAPI.getBlogArticlesCount(blogID)).count;
        }
        return blogArticles;
    }

    async pullBlogArticles(destDir = "./shopify", blog=null) {

        // which blog?
        if (!blog) {
            const blogs = await this.getBlogs();
            await Promise.all(blogs.map(async b => await this.pullBlogArticles(destDir, b.id)));
            return;
        }

        let blogDetails;
        if (Number.isInteger(blog)) {
            blogDetails = (await this.shopifyAPI.getBlog(blog)).blog;
        }
        else {
            const blogs = await this.getBlogs();
            const blogDetails = blogs.filter(b => b.handle === blog)[0];
            if (!blogDetails) return;
        }
        const blogID = blogDetails.id;
        const blogName = blogDetails.handle;

        const blogArticlesDir = path.join(destDir, "blogs", blogName);
        const blogArticlesDraftDir = path.join(blogArticlesDir, "drafts");

        const remoteBlogArticles = await this.getBlogArticles(blogID);
        const localFiles = new Set();
        for await (const file of getFiles(blogArticlesDir)) {
            localFiles.add(path.relative(blogArticlesDir, file));
        }

        console.log(`SAVING: blog/*`)
        for (const blogArticle of remoteBlogArticles) {
            const handle = blogArticle.handle;
            const html = blogArticle.body_html || "";
            const filename = path.join(blogArticle.published_at ? blogArticlesDir : blogArticlesDraftDir, handle);
            cleanObject(blogArticle, PAGES_OBJECT_CLEANUP);
            blogArticle.body_html = {file: `${handle}.html`};

            console.info(`SAVING: ${blogArticle.published_at ? "" : "drafts/"}${handle}.html`);
            await this.#saveFile(filename + ".json", JSON.stringify(blogArticle, null, 2));
            await this.#saveFile(filename + ".html", html);
            localFiles.delete(path.relative(blogArticlesDir, filename) + ".json");
            localFiles.delete(path.relative(blogArticlesDir, filename) + ".html");
        }
        //TODO: delete
        for (const f of localFiles) {
            console.log(`DELETE ${f}`);
//            fs.unlinkSync(path.join(destDir, f));
        }

    }

    async pushBlogArticles(destDir = "./shopify", blog) {

        // which blog?
        if (!blog) {
            const blogs = await this.getBlogs();
            await Promise.all(blogs.map(async b => await this.pushBlogArticles(destDir, b.id)));
            return;
        }

        let blogDetails;
        if (Number.isInteger(blog)) {
            blogDetails = (await this.shopifyAPI.getBlog(blog)).blog;
        }
        else {
            const blogs = await this.getBlogs();
            const blogDetails = blogs.filter(b => b.handle === blog)[0];
            if (!blogDetails) return;
        }
        const blogID = blogDetails.id;
        const blogName = blogDetails.handle;

        const blogArticlesDir = path.join(destDir, "blogs", blogName);
        const blogArticlesDraftDir = path.join(blogArticlesDir, "drafts");

        const remoteBlogArticles = await this.getBlogArticles();
        const readBlogArticleFile = (file) => {
            if (!fs.existsSync(file)) return;
            const d = this.#readFile(file);
            const data = JSON.parse(d);
            if (data.body_html && data.body_html.file) {
                data.body_html = this.#readFile(path.join(path.dirname(file), data.body_html.file));
            }
            return data;
        }

        const localFiles = new Set();
        for await (const file of getFiles(blogArticlesDir)) {
            if (!file.endsWith(".json")) continue; // only look for the .json files (implying the .html files)
            localFiles.add(path.relative(blogArticlesDir, file).replace(/\.json$/,""));
        }

        const updateBlogArticle = new Set();
        const deleteBlogArticles = new Set();

        for (const blogArticle of remoteBlogArticles) {
            const handle = blogArticle.handle;
            const draftHandle = path.join("drafts", handle);

            if (localFiles.has(handle) || localFiles.has(draftHandle)) {
                const detail = readBlogArticleFile(path.join(blogArticlesDir, handle + ".json")) || readBlogArticleFile(path.join(blogArticlesDraftDir, handle + ".json"));

                //if the file exists in both drafts and published, we bias to the published entry
                detail.published = !localFiles.has(draftHandle) || localFiles.has(handle);
                if (!detail.published) delete detail.published_at; // not enough just to say it is not published
                detail.handle = handle;
                detail.id = blogArticle.id;
                blogArticle.published = (!!blogArticle.published_at);

                if (!isSame(blogArticle, detail, PAGES_OBJECT_CLEANUP_EXT)) {
                    updateBlogArticle.add(detail);
                }
                localFiles.delete(handle);
                localFiles.delete(draftHandle);
            }
            else {
                deleteBlogArticles.add(blogArticle);
            }
        }
        // Creates
        await Promise.all([...localFiles].map(async file => {
            const blogArticle = readBlogArticleFile(path.join(blogArticlesDir, file + ".json"));
            //cleanup properties that might have been cloned
            delete blogArticle.id;
            if (!detail.published) delete blogArticle.published_at;
            blogArticle.published = file.startsWith("drafts");
            blogArticle.handle = file.replace("drafts/", "");

            console.log(`CREATE blogArticles/${file}`);
            await this.shopifyAPI.createBlogArticle(blogArticle);
        }));
        // Updates
        await Promise.all([...updateBlogArticle].map(async file => {
            console.log(`UPDATE blogArticles/${file.handle})`);
            await this.shopifyAPI.updateBlogArticle(file.id, file);
        }));
        // Deletes
        await Promise.all([...deleteBlogArticles].map(async file => {
            console.log(`DELETE blogArticles/${file.handle}`);
            await this.shopifyAPI.deleteBlogArticle(file.id);
        }));
    }
}

module.exports = Shopify;
