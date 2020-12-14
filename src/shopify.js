const fs = require('fs');
const path = require('path');
const { fetch } = require('fetch-h2');
const ShopifyAPI = require('./shopify-api');
const {getFiles, globAsRegex, md5File, md5, cleanObject, isSame} = require('./utils');
const { stringify } = require('./stringify');

const PAGES_IGNORE_ATTRIBUTES = ["id", "key", "handle", "shop_id", "admin_graphql_api_id"];
const PAGES_IGNORE_ATTRIBUTES_EXT = [...PAGES_IGNORE_ATTRIBUTES, "published_at", "created_at", "updated_at", "deleted_at"];

class Shopify {
    constructor(auth) {
        this.shopifyAPI = new ShopifyAPI(auth);
    }

    static handleName(name) {
        return name.normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9-_]+/g, "_")
            .replace(/^_+|_+$/g, "");
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

    async listThemes() {
        const data = await this.shopifyAPI.getThemes();
        data.themes.forEach(t => t.handle = Shopify.handleName(t.name));
        return data.themes;
    }

    async #getThemeID(name = null) {
        const res = await this.listThemes();

        //TODO: normalize name?
        return res.filter(t => (!name && t.role === 'main') || t.handle === Shopify.handleName(name))[0];
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

    async listAssets(themeName, includeVersions = false) {
        const theme = await this.#getThemeID(themeName);
        const remoteAssets = await this.#getAssets(theme.id);
        if (includeVersions) {
            await Promise.all(remoteAssets.map(async asset => {
                const v = await this.shopifyAPI.getAssetVersions(theme.id, asset.key).catch(e => console.debug(e));
                if (v && v.versions && v.versions.length > 0) {
                    asset.versions = v.versions;
                }
            }));
        }
        return remoteAssets;
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
            if (force || !(await this.#isAssetSame(filename, asset.checksum, asset.updated_at, asset.size))) {
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
                            // console.log(`${asset.key} - ${require('crypto').createHash('md5').update(JSON.stringify(JSON.parse(detail.asset.value))).digest('hex')}`)
                            data = stringify(JSON.parse(data));
                        }

                        await this.#saveFile(filename, data);
                    }
                }
            }
            else {
                console.debug(`SKIP: ${filename}`);
            }

        }))

        for (const f of localFiles) {
            console.log(`DELETE ${f}`);
            if (!dryrun) fs.unlinkSync(path.join(destDir, f));
        }
        return remoteAssets;
    }

    async pushAssets(themeName = null, destDir = "./shopify", force = false, dryrun=false) {
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

    //
    // Redirects
    //
    async listRedirects() {
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

    async pullRedirects(destDir = "./shopify", force = false, dryrun=false) {
        const redirects = await this.listRedirects();
        const filename = path.join(destDir, "redirects.csv");
        //TODO: .replace(",", "%2C")
        const csvData = ["Redirect from,Redirect to", ...redirects.map(r => r.path + "," + r.target)].join('\n');
        if (force || await md5File(filename) !== md5(csvData)) {
            console.log(`SAVING: redirects.csv`);
            if (!dryrun) await this.#saveFile(filename, csvData);
        }
        return redirects;
    }
    async pushRedirects(destDir = "./shopify", force = false, dryrun=false) {
        const data = await this.listRedirects();
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

    //
    // Script Tags
    //
    async listScriptTags() {
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

    async pullScriptTags(destDir = "./shopify", force = false, dryrun=false) {
        const scripts = await this.listScriptTags();

        const filename = path.join(destDir, "scripts.csv");
        //TODO: .replace(",", "%2C")
        const csvData = ["src,event,scope", ...scripts.map(s => s.src + "," + s.event + "," + s.display_scope)].join('\n');

        if (force || await md5File(filename) !== md5(csvData)) {
            console.log(`SAVING: scripts.csv`);
            if (!dryrun) await this.#saveFile(filename, csvData);
        }
        return scripts;
    }
    async pushScriptTags(destDir = "./shopify", force = false, dryrun=false) {
        const data = await this.listScriptTags();
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

    //
    // Pages
    //
    async listPages() {
        let count = null;
        const pages = [];
        while (count === null || pages.length < count) {
            const maxID = Math.max(0, ...pages.map(r => r.id));
            const data = await this.shopifyAPI.getPages(maxID)
            pages.push(...data.pages);
            if (count === null) count = pages.length < 250 ? pages.length : (await this.shopifyAPI.getPagesCount()).count;
        }
        pages.forEach(p => p.key = path.join("pages", p.published_at ? "" : "drafts", p.handle));
        return pages;
    }

    async pullPages(destDir = "./shopify", force = false, dryrun=false) {
        const pagesDir = path.join(destDir, "pages");
        const pagesDraftDir = path.join(pagesDir, "drafts");

        const remotePages = await this.listPages();

        const localFiles = new Set([...await this.getLocalFiles(destDir, "pages")].map(file => path.relative("pages", file)));

        for (const page of remotePages) {
            const handle = page.handle;
            const html = page.body_html;
            const key = page.key;
            page.body_html = {file: `${handle}.html`};

            const filename = path.join(destDir, page.key);
            localFiles.delete(page.key + ".json");
            localFiles.delete(page.key + ".html");

            const jsonData = JSON.stringify(cleanObject(page, PAGES_IGNORE_ATTRIBUTES), null, 2);
            if (force || await md5File(filename + ".json") !== md5(jsonData) || await md5File(filename + ".html") !== md5(html)) {
                console.info(`SAVING: ${key}.html`);
                if (!dryrun) {
                    await this.#saveFile(filename + ".json", jsonData);
                    await this.#saveFile(filename + ".html", html);
                }
            }
        }

        for (const f of localFiles) {
            console.log(`DELETE ${f}`);
            if (!dryrun) fs.unlinkSync(path.join(destDir, f));
        }
    }

    async pushPages(destDir = "./shopify", force = false, dryrun=false) {
        const pagesDir = path.join(destDir, "pages");
        const pagesDraftDir = path.join(pagesDir, "drafts");

        const remotePages = await this.listPages();
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

                if (!isSame(page, detail, PAGES_IGNORE_ATTRIBUTES_EXT)) {
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
    async listBlogs() {
        let count = null;
        const blogs = [];
        while (count === null || blogs.length < count) {
            const maxID = Math.max(0, ...blogs.map(r => r.id));
            const data = await this.shopifyAPI.getBlogs(maxID)
            blogs.push(...data.blogs);
            if (count === null) count = blogs.length < 250 ? blogs.length : (await this.shopifyAPI.getBlogsCount()).count;
        }
        blogs.forEach(b => b.key = path.join("blogs", b.handle));
        return blogs;
    }
    async listBlogArticles(blog) {
        if (!blog) {
            const blogs = await this.listBlogs();
            return await Promise.all(blogs.map(async b => await this.listBlogArticles(b.id)));
        }

        const blogs = await this.listBlogs();
        const blogDetails = blogs.filter(b => Number.isInteger(blog) ? b.id === blog : b.handle === Shopify.handleName(blog))[0];
        blogDetails.articles = [];
        const blogArticles = blogDetails.articles;
        let count = null;
        while (count === null || blogArticles.length < count) {
            const maxID = Math.max(0, ...blogArticles.map(r => r.id));
            const data = await this.shopifyAPI.getBlogArticles(blogDetails.id, maxID)
            blogArticles.push(...data.articles);
            if (count === null) count = blogArticles.length < 250 ? blogArticles.length : (await this.shopifyAPI.getBlogArticlesCount(blogDetails.id)).count;
        }
        blogArticles.forEach(a => a.key = path.join(a.published_at ? "" : "drafts", a.handle));
        return blogDetails;
    }

    async pullBlogArticles(destDir = "./shopify", blog=null, force = false, dryrun=false) {

        // which blog?
        if (!blog) {
            const blogs = await this.listBlogs();
            return await Promise.all(blogs.map(async b => await this.pullBlogArticles(destDir, b.id, force, dryrun)));
        }

        const blogDetails = await this.listBlogArticles(blog);
        if (!blogDetails) return;

        const blogArticlesDir = path.join(destDir, blogDetails.key);

        const localFiles = new Set();
        for await (const file of getFiles(blogArticlesDir)) {
            localFiles.add(path.relative(blogArticlesDir, file));
        }

        for (const blogArticle of blogDetails.articles || []) {
            const handle = blogArticle.handle;
            const html = blogArticle.body_html || "";
            const key = blogArticle.key;
            blogArticle.body_html = {file: `${handle}.html`};

            const filename = path.join(blogArticlesDir, blogArticle.key);
            localFiles.delete(blogArticle.key + ".json");
            localFiles.delete(blogArticle.key + ".html");

            const jsonData = JSON.stringify(cleanObject(blogArticle, PAGES_IGNORE_ATTRIBUTES), null, 2);
            if (force || await md5File(filename + ".json") !== md5(jsonData) || await md5File(filename + ".html") !== md5(html)) {
                console.log(`SAVING: ${blogDetails.key}/${key}.html`);
                if (!dryrun) {
                    await this.#saveFile(filename + ".json", jsonData);
                    await this.#saveFile(filename + ".html", html);
                }
            }
        }
        //TODO: delete
        for (const f of localFiles) {
           console.log(`DELETE ${f}`);
            if (!dryrun) fs.unlinkSync(path.join(blogArticlesDir, f));
        }

    }

    async pushBlogArticles(destDir = "./shopify", blog, force = false, dryrun=false) {

        // which blog?
        if (!blog) {
            const blogs = await this.listBlogs();
            await Promise.all(blogs.map(async b => await this.pushBlogArticles(destDir, b.id)));
            return;
        }

        const blogDetails = await this.listBlogArticles(blog);
        if (!blogDetails) return;

        const blogArticlesDir = path.join(destDir, blogDetails.key);

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
            if (!file.endsWith(".html")) continue; // only look for the .html files (implying the .json files)
            localFiles.add(path.relative(blogArticlesDir, file).replace(/\.html$/,""));
        }

        const updateBlogArticle = new Set();
        const deleteBlogArticles = new Set();

        for (const remoteArticle of blogDetails.articles) {
            const handle = remoteArticle.handle;
            const draftHandle = path.join("drafts", handle);

            if (localFiles.has(handle) || localFiles.has(draftHandle)) {
                // Local file matches, is this a CREATE or UPDATE?
                const localArticle = readBlogArticleFile(path.join(blogArticlesDir, handle + ".json")) || readBlogArticleFile(path.join(blogArticlesDir, draftHandle + ".json"));

                //if the file exists in both drafts and published, we bias to the published entry
                localArticle.published = !localFiles.has(draftHandle) || localFiles.has(handle);
                if (!localArticle.published) delete localArticle.published_at; // not enough just to say it is not published
                remoteArticle.published = (!!remoteArticle.published_at);

                //normalize the basics
                localArticle.handle = Shopify.handleName(handle);
                localArticle.id = remoteArticle.id;

                if (!isSame(remoteArticle, localArticle, PAGES_IGNORE_ATTRIBUTES_EXT)) {
                    updateBlogArticle.add(localArticle);
                }
                localFiles.delete(handle);
                localFiles.delete(draftHandle);
            }
            else {
                // Local file not found, this is DELETE
                deleteBlogArticles.add(remoteArticle);
            }
        }
        // Creates
        await Promise.all([...localFiles].map(async file => {
            const blogArticle = readBlogArticleFile(path.join(blogArticlesDir, file + ".json"));

            //cleanup properties that might have been cloned
            delete blogArticle.id;
            if (!detail.published) delete blogArticle.published_at;
            blogArticle.published = file.startsWith("drafts");
            blogArticle.handle = Shopify.handleName(file.replace(/drafts[\/\\]/, ""));

            console.log(`CREATE blogs/${blogDetails.handle}/${file}`);
            await this.shopifyAPI.createBlogArticle(blogArticle);
        }));
        // Updates
        await Promise.all([...updateBlogArticle].map(async file => {
            console.log(`UPDATE blogs/${blogDetails.handle}/${file.handle})`);
            await this.shopifyAPI.updateBlogArticle(file.id, file);
        }));
        // Deletes
        await Promise.all([...deleteBlogArticles].map(async file => {
            console.log(`DELETE blogs/${blogDetails.handle}/${file.handle}`);
            await this.shopifyAPI.deleteBlogArticle(file.id);
        }));
    }

    //
    // Menu
    //
    async listMenus() {
        let data = null;
        const menus = [];
        while (data === null || data.menus.length  === 250) {
            const maxID = Math.max(0, ...menus.map(r => r.id));
            data = await this.shopifyAPI.getMenus(maxID)
            menus.push(...data.menus);
        }
        menus.forEach(b => b.key = path.join("menus", b.handle));
        return menus;
    }

    async pullMenus(destDir = "./shopify", force = false, dryrun=false) {
        const menus = await this.listMenus();

        const menuToYml = function(currItems = [], indent = "") {
            return currItems.map(item => [`${indent}- ${item.title}`,menuToYml(item.items, "  " + indent)]);
        }

        const localFiles = new Set();
        for await (const file of getFiles(path.join(destDir, "menus"))) {
            localFiles.add(path.relative(destDir, file));
        }

        for (const menu of menus) {
            const filename = path.join(destDir, menu.key + ".md");
            const menuDetails = await this.shopifyAPI.getMenu(menu.id);
            const data = ["# " + menuDetails.menu.title, menuToYml(menuDetails.menu.items)].flat(99).join('\n');
            //TODO: .replace(",", "%2C")
            if (force || await md5File(filename) !== md5(data)) {
                console.log(`SAVING: ${menu.key}.md`);
                if (!dryrun) await this.#saveFile(filename, data);
            }
            localFiles.delete(menu.key + ".md");
        }
        //TODO: delete
        for (const f of localFiles) {
           console.log(`DELETE ${f}`);
            if (!dryrun) fs.unlinkSync(path.join(destDir, f));
        }

        return menus;
    }
}

module.exports = Shopify;
