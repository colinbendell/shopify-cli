const fs = require('fs');
const path = require('path');
const { fetch } = require('fetch-h2');
const ShopifyAPI = require('./shopify-api');
const {getFiles, globAsRegex, md5File, md5, cleanObject, isSame} = require('./utils');
const { stringify } = require('./stringify');

const PAGES_IGNORE_ATTRIBUTES = ["id", "key", "handle", "shop_id", "admin_graphql_api_id"];
const BLOGS_IGNORE_ATTRIBUTES = ["id", "key", "handle", "shop_id", "admin_graphql_api_id", "body_html", "blog_id"];
const PAGES_IGNORE_ATTRIBUTES_EXT = [...PAGES_IGNORE_ATTRIBUTES, "published_at", "created_at", "updated_at", "deleted_at"];

class ShopifyCore {
    constructor(auth) {
        this.shopifyAPI = new ShopifyAPI(auth);
    }

    get host() { return this.shopifyAPI.host; }

    static get THEME_DIRS() { return ["assets","layout","sections","templates","config","locales","snippets"]};

    static handleName(name) {
        return name.toString()
            .normalize("NFD")
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

    async getChangeSets(theme, options) {
        // we use the current theme to match against other 'draft' themes that are similar to back fill the history
        const currTheme = await this.getTheme(theme);

        // back fill of parallel theme history includes any theme that had development prior to the creation of the current theme
        let themeAssets = [await this.listAssets(null, true)].flat()
        themeAssets = themeAssets.filter(
            t => t.id === currTheme.id
                || (!currTheme.theme_store_id && !t.theme_store_id && Date.parse(t.created_at) <= Date.parse(currTheme.created_at))
                //TODO: theme_store_id is null after a clone from a theme_store_id
                || (currTheme.theme_store_id === t.theme_store_id && Date.parse(t.created_at) <= Date.parse(currTheme.created_at)));

        for (const theme of [themeAssets].flat()) {
            if (theme.id === currTheme.id) continue;
            theme.assets = theme.assets.filter(a => Date.parse(a.created_at) <= Date.parse(currTheme.created_at));
            for (const currAsset of theme.assets) {
                if (currAsset.versions && currAsset.versions.length > 0) {
                    currAsset.versions = currAsset.versions.filter(
                        v => Date.parse(v.created_at) <= Date.parse(currTheme.created_at)
                        || v.version === 1 //Special case where version 1 created_at is the actual date it was copied into the theme
                    );
                    if (currAsset.versions === 0) {
                        theme.assets = theme.assets.filter(a => a !== currAsset);
                    }
                }
            }
        }

        const menus = (options.menus ? await this.listMenus().catch(() => {}) : null) || [];
        const pages = (options.pages ? await this.listPages() : null) || [];
        const blogArticles = (options.blogs ? await this.listBlogArticles() : null) || [];
        const scriptTags = (options.scripts ? await this.listScriptTags() : null) || [];
        // redirects aren't update/create time versioned
        // const redirects = await shopify.listRedirects();

        // const products = await this.listProducts();
        const changeSet = new Map();
        changeSet.add = function(updatedAt, value) {
            const valueDate = new Date(Date.parse(updatedAt) || 0).toISOString();
            if (!this.has(valueDate)) this.set(valueDate, []);
            this.get(valueDate).push(value);
        }

        for (const theme of [themeAssets].flat()) {
            for (const asset of theme.assets || []) {
                if (!asset.versions || asset.versions.length === 0) {
                    // use updated_at not created_at since @v created_at might not available
                    //TODO: change this to a tuple instead of string concatenation magic
                    changeSet.add(asset.updated_at, theme.id + "~" + theme.handle + "~" + asset.key);
                }
                asset.versions?.forEach(item => {
                    //special case where the first version created_at is the actual date vs updated_at when it was opened first
                    const createdAt = item.version === 1 ? asset.created_at : item.created_at;
                    changeSet.add(createdAt, theme.id + "~" + theme.handle + "~" + asset.key + "@" + item.version)
                });
            }
        }
        menus.forEach(item => changeSet.add(item.updated_at, item.key));
        pages.forEach(item => changeSet.add(item.updated_at, item.key + ".html"));
        blogArticles.forEach(blog => {
            blog.articles?.forEach(item => changeSet.add(item.updated_at, path.join(blog.key, item.key + ".html")));
        });
        scriptTags.forEach(item => changeSet.add(item.updated_at, item.src));
        // redirect.forEach(item => changeSet.add(item.updated_at, item.path));

        // reduce the changesets with near neighbours
        let prev = 0;
        for (const curr of [...changeSet.keys()].sort()) {
            if (Date.parse(curr) - Date.parse(prev) <= 60*1000) {
                const left = changeSet.get(prev);
                const leftClean = new Set(left.map(v => v.replace(/^[a-z0-9._-]+~|@\d+$/g, "")));

                const right = changeSet.get(curr);
                const mergeable = !right.reduce((found, entry) => found || leftClean.has(entry.replace(/^[a-z0-9._-]+~|@\d+$/g, "")), false)
                if (mergeable) {
                    changeSet.set(curr, left.concat(right));
                    changeSet.delete(prev);
                }
            }
            prev = curr;
        }
        return changeSet;
    }

    async listThemes() {
        const data = await this.shopifyAPI.getThemes();
        data.themes.forEach(t => t.handle = ShopifyCore.handleName(t.name));
        return data.themes;
    }

    async getTheme(name = null) {
        const res = await this.listThemes();

        //TODO: normalize name?
        return res.filter(t =>
            (!name && t.role === 'main')
            || (t.id === Number.parseInt(name) || 0)
            || (name && t.handle === ShopifyCore.handleName(name))
        )[0];
    }

    async publishTheme(themeName) {
        if (!themeName) return;

        const theme = await this.getTheme(themeName);
        if (!theme || !theme.id) return;
        if (theme.role !== 'main') return;

        console.log(`PUBLISHING: ${theme.name}`);
        await this.shopifyAPI.updateTheme(theme.id, theme.name, 'main')
    }

    async createTheme(themeName, src = null) {
        if (!themeName) return;

        const theme = await this.getTheme(themeName);
        if (theme) return;

        console.info(`CREATE Theme: "${themeName}"`);
        await this.shopifyAPI.createTheme(themeName, 'unpublished', src)
    }

    async deleteTheme(themeName) {
        if (!themeName) return;

        const theme = await this.getTheme(themeName);

        if (!theme) return;
        if (theme.role === 'main') throw Error(`Theme "${theme.name}" is currently published; Cannot delete`);

        console.info(`DELETE Theme: "${themeName}"`);
        await this.shopifyAPI.deleteTheme(theme.id);
    }

    async #isAssetSame(localFilename, remoteCheckSum = null, remoteLastModified = null, remoteSize) {
        if (remoteLastModified) remoteLastModified = new Date(remoteLastModified).getTime();
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

        if (remoteLastModified && localSize === Number(remoteSize)) {
            if (localLastModified + 5*60*1000 >= remoteLastModified) {
                return true
            }
        }
        else if (localSize === Number(remoteSize)) {
            return true;
        }
        return false;
    }

    async listAssets(themeName, includeVersions = false) {
        if (!themeName) {
            const themes = await this.listThemes();
            const result = [];
            for (const t of themes) {
                result.push(await this.listAssets(t.id, includeVersions));
            }
            return result;
        }

        const theme = await this.getTheme(themeName);
        if (!theme || !theme.id) return;

        const data = await this.shopifyAPI.getAssets(theme.id);

        const assetsMap = new Map(data.assets.map(a => [a.key, a]));
        for (const key of assetsMap.keys()) {
            if (assetsMap.has(key + ".liquid")) {
                assetsMap.delete(key);
            }
        }
        theme.assets = [...assetsMap.values()];

        if (includeVersions) {
            await Promise.all(theme.assets.map(async asset => {
                const v = asset.versions ?? await this.shopifyAPI.getAssetVersions(theme.id, asset.key).catch(e => console.debug(e));
                asset.versions = v?.versions || [];
            }));
        }
        return theme;
    }

    async pullAssets(themeName = null, destDir = "./shopify", force = false, dryrun=false, filter= null) {
        const themeDir = path.join(destDir, "theme");
        const filterDate = Date.parse(filter?.createdAt);
        const theme = await this.getTheme(themeName);
        if (!theme || !theme.id) return [];

        const themeDetails = await this.listAssets(theme.id, !!filterDate);
        let remoteAssets = themeDetails.assets;

        //todo: turn this into a generator
        if (filterDate) {
            remoteAssets.forEach(asset =>
                asset.version = asset?.versions?.filter(item => filterDate >= Date.parse(item.created_at))
                    .map(item => item.version)
                    .sort((a,b) => a - b)[0]
            );
            remoteAssets = remoteAssets.filter(item => item.version || filterDate >= Date.parse(item.updated_at));
        }

        const localFiles = await this.getLocalFiles(themeDir, ShopifyCore.THEME_DIRS);

        await Promise.all(remoteAssets.map(async asset => {
            const filename = path.join(themeDir, asset.key);
            localFiles.delete(asset.key);

            // API optimization
            if (force || asset.version || !(await this.#isAssetSame(filename, asset.checksum, asset.updated_at, asset.size))) {
                console.log(`SAVING: ${asset.key}`)
                if (dryrun) {
                    //no-op
                }
                else if (asset.public_url) {
                    const res = await fetch(asset.public_url);
                    await this.#saveFile(path.join(themeDir, asset.key), Buffer.from(await res.arrayBuffer()));
                }
                else {
                    const detail = await this.shopifyAPI.getAsset(theme.id, asset.key, asset?.version?.version);
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

        // we don't delete when filtering
        if (filterDate) localFiles.clear();

        for (const f of localFiles) {
            console.log(`DELETE ${f}`);
            if (!dryrun) fs.unlinkSync(path.join(themeDir, f));
        }
        return remoteAssets;
    }

    async pushAssets(themeName = null, destDir = "./shopify", force = false, dryrun=false) {
        const themeDir = path.join(destDir, "theme");
        const theme = await this.listAssets(themeName);
        if (!theme || !theme.id) return [];

        const remoteAssets = theme.assets;

        const localFiles = await this.getLocalFiles(themeDir, ShopifyCore.THEME_DIRS);
        const deletePaths = new Set();

        // this loop inspection is opposite the other ones. should iterate over the local files not the remote files
        for (const asset of remoteAssets) {
            const filename = path.join(themeDir, asset.key);
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
        // parallelize the rest
        const SPECIAL_ASSET_UPLOAD_ORDER = ['config/settings_schema.json', 'config/settings_data.json'];
        const updateAsset = async key => {
            console.log(`UPDATE: ${key}`);
            //TODO: make this work for binary (use attachment)
            const data = this.#readFile(path.join(themeDir, key));
            const stringValue = typeof data === "string" ? data : null;
            const attachmentValue = typeof data !== "string" ? Buffer.from(data).toString("base64") : null;
            if (!dryrun) await this.shopifyAPI.updateAsset(theme.id, key, stringValue, attachmentValue);
        }
        await Promise.all([...localFiles.values()].map(async key => {
            if (SPECIAL_ASSET_UPLOAD_ORDER.includes(key)) return;
            await updateAsset(key);
        }));
        // for some files we need to upload in order. The rest can be parallelized
        for (const key of SPECIAL_ASSET_UPLOAD_ORDER) {
            if (localFiles.has(key)) {
                await updateAsset(key);
            }
        }
        // Deletes
        await Promise.all([...deletePaths.values()].map(async key => {
            console.log(`DELETE: ${key}`)
            if (!dryrun) await this.shopifyAPI.deleteAsset(theme.id, key);
        }));

        return remoteAssets;
    }

    async watchAssets(themeName = null, destDir = "./shopify", force = false, dryrun=false) {
        const themeDir = path.join(destDir, "theme");
        const theme = await this.listAssets(themeName);
        if (!theme || !theme.id) return [];

        const tempLog = console.log;
        console.log = console.info;
        await this.pushAssets(themeName, themeDir, force, dryrun);
        console.log = tempLog;

        const localFiles = await this.getLocalFiles(themeDir, ShopifyCore.THEME_DIRS);
        const localAssets = new Map();
        for (const relativeFile of localFiles) {
            const fullFilename = path.join(themeDir, relativeFile);
            localAssets.set(fullFilename, await md5File(fullFilename));
        }

        const fsWait = new Set();
        const changes = new Set();
        const applyChanges = async () => {
            for (const filename of changes) {
                // loop through the batched changes and apply only the entries that are create or update
                changes.delete(filename);
                if (this.#matchesShopifyIgnore(themeDir, filename)) continue;
                const md5 = await md5File(filename);
                if (!md5) continue; // deleted?

                if (!localAssets.has(filename) || localAssets.get(filename) !== md5) {

                    const relativeFile = path.relative(themeDir, filename);
                    const data = this.#readFile(filename);
                    if (!data) continue; // deleted?

                    console.log(`UPDATE: ${relativeFile}`);
                    const stringValue = typeof data === "string" ? data : null;
                    const attachmentValue = typeof data !== "string" ? Buffer.from(data).toString("base64") : null;
                    await this.shopifyAPI.updateAsset(theme.id, relativeFile, stringValue, attachmentValue);
                    localAssets.set(filename, md5);
                }
            }
        }
        for (const watchDir of ShopifyCore.THEME_DIRS) {
            console.info(`Watching for changes: /theme/${watchDir}`);

            fs.watch(path.join(themeDir, watchDir), (event, relativeFile) => {
                if (!relativeFile) return; // when would this happen?

                console.info (`${event}: ${path.join(watchDir, relativeFile)}`);
                const filename = path.join(themeDir, watchDir, relativeFile);
                changes.add(filename);

                for (const id of fsWait) {
                    // clear any delays to batch up our work;
                    clearTimeout(id);
                    fsWait.delete(id);
                }

                const timeoutID = setTimeout(applyChanges, 100);

                fsWait.add(timeoutID);
            });
        }
    }

    //
    // Redirects
    //
    async listRedirects() {
        const redirects = [];
        let data = null
        while (!data || data?.redirects.length === 250) {
            const maxID = Math.max(0, ...redirects.map(r => r.id));
            data = await this.shopifyAPI.getRedirects(maxID);
            redirects.push(...data.redirects);
        }
        return redirects;
    }

    async pullRedirects(destDir = "./shopify", force = false, dryrun=false) {
        const redirects = await this.listRedirects();
        const filename = path.join(destDir, "redirects.csv");
        const csvData = [
            "Redirect from,Redirect to",
            ...redirects.map(r => `${r.path},${r.target}`)
            //TODO: .replace(",", "%2C")
        ].join('\n');
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
            if (!path || !target) continue; // skip empty lines or the first row;

            if (originalPaths.has(path)) {
                const detail = originalPaths.get(path);
                if (force || detail.target !== target) {
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
            if (!dryrun) await this.shopifyAPI.createRedirect(r.path, r.target);
        }));
        // Updates
        await Promise.all([...updatePaths.values()].map(async r => {
            console.log(`UPDATE 302: ${r.path} => ${r.target}`);
            if (!dryrun) await this.shopifyAPI.updateRedirect(r.id, r.path, r.target);
        }));
        // Deletes
        await Promise.all([...originalPaths.values()].map(async r => {
            console.log(`DELETE 302: ${r.path}`);
            if (!dryrun) await this.shopifyAPI.deleteRedirect(r.id);
        }));
        return localCSV;
    }

    //
    // Script Tags
    //
    async listScriptTags() {

        const scripts = [];
        let data = null;
        while (!data || data?.script_tags.length === 250) {
            const maxID = Math.max(0, ...scripts.map(r => r.id));
            data = await this.shopifyAPI.getScriptTags(maxID)
            scripts.push(...data.script_tags);
        }
        return scripts;
    }

    async pullScriptTags(destDir = "./shopify", force = false, dryrun=false, filter= null) {
        let scripts = await this.listScriptTags();
        //todo: turn this into a generator
        const filterDate = Date.parse(filter?.createdAt);
        if (filterDate) {
            scripts = scripts.filter(item => filterDate >= Date.parse(item.updated_at));
        }
        const filename = path.join(destDir, "scripts.csv");
        const csvData = [
            "src,event,scope",
            ...scripts.map(s => `${s.src},${s.event},${s.display_scope}`)
            //TODO: .replace(",", "%2C")
        ].join('\n');

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
                if (force || detail.event !== event || detail.display_scope !== scope) {
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
            if (!dryrun) await this.shopifyAPI.createScriptTags(s.src, s.target);
        }));
        // Updates
        await Promise.all([...updateScripts.values()].map(async s => {
            console.log(`UPDATE ScriptTag: ${s.src} ${s.event} (${s.display_scope})`);
            if (!dryrun) await this.shopifyAPI.updateScriptTags(s.id, s.src, s.event, s.display_scope);
        }));
        // Deletes
        await Promise.all([...originalScripts.values()].map(async s => {
            console.log(`DELETE ScriptTag: ${s.src}`);
            if (!dryrun) await this.shopifyAPI.deleteScriptTags(s.id);
        }));
        return localCSV;
    }

    //
    // Pages
    //
    async listPages(baseDir = "pages") {
        const pages = [];
        let data = null;
        while (!data || data?.pages.length  === 250) {
            const maxID = Math.max(0, ...pages.map(r => r.id));
            data = await this.shopifyAPI.getPages(maxID)
            pages.push(...data.pages);
        }
        pages.forEach(p => p.key = path.join(baseDir, p.published_at ? "" : "drafts", p.handle));
        return pages;
    }

    async pullPages(destDir = "./shopify", force = false, dryrun=false, filter= null) {
        let remotePages = await this.listPages();
        //todo: turn this into a generator
        const filterDate = Date.parse(filter?.createdAt);
        if (filterDate) {
            remotePages = remotePages.filter(item => filterDate >= Date.parse(item.updated_at));
        }

        const localFiles = new Set([...await this.getLocalFiles(destDir, "pages")].map(file => path.relative("pages", file)));

        for (const page of remotePages) {
            const pageClone = Object.assign({}, page);
            const handle = pageClone.handle;
            const html = pageClone.body_html || "";
            const key = pageClone.key;
            pageClone.body_html = {file: `${handle}.html`};

            const filename = path.join(destDir, pageClone.key);
            localFiles.delete(page.key + ".json");
            localFiles.delete(page.key + ".html");

            const jsonData = JSON.stringify(cleanObject(pageClone, PAGES_IGNORE_ATTRIBUTES), null, 2);
            if (force || await md5File(filename + ".json") !== md5(jsonData) || await md5File(filename + ".html") !== md5(html)) {
                console.info(`SAVING: ${key}.html`);
                if (!dryrun) {
                    await this.#saveFile(filename + ".json", jsonData);
                    await this.#saveFile(filename + ".html", html);
                }
            }
        }

        // we don't delete when filtering
        if (filterDate) localFiles.clear();

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

                if (force || !isSame(page, detail, PAGES_IGNORE_ATTRIBUTES_EXT)) {
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
            if (!dryrun) await this.shopifyAPI.createPage(page);
        }));
        // Updates
        await Promise.all([...updatePage].map(async file => {
            console.log(`UPDATE pages/${file.handle})`);
            if (!dryrun) await this.shopifyAPI.updatePage(file.id, file);
        }));
        // Deletes
        await Promise.all([...deletePages].map(async file => {
            console.log(`DELETE pages/${file.handle}`);
            if (!dryrun) await this.shopifyAPI.deletePage(file.id);
        }));
    }

    //
    // Blogs
    //
    async listBlogs(baseDir = "blogs") {
        let data = null;
        const blogs = [];
        while (!data || data?.blogs.length  === 250) {
            const maxID = Math.max(0, ...blogs.map(r => r.id));
            data = await this.shopifyAPI.getBlogs(maxID)
            blogs.push(...data.blogs);
        }
        blogs.forEach(b => b.key = path.join(baseDir, b.handle));
        return blogs;
    }

    async listBlogArticles(blog = null) {
        if (!blog) {
            const blogs = await this.listBlogs();
            return await Promise.all(blogs.map(async b => await this.listBlogArticles(b.id)));
        }

        const blogs = await this.listBlogs();
        const blogDetails = blogs.filter(b => Number.isInteger(blog) ? b.id === blog : b.handle === ShopifyCore.handleName(blog))[0];

        // not found; return null;
        if (!blogDetails) return;

        blogDetails.articles = [];
        const articles = blogDetails.articles;
        let data = null;
        while (!data || data?.articles.length  === 250) {
            const maxID = Math.max(0, ...articles.map(r => r.id));
            data = await this.shopifyAPI.getBlogArticles(blogDetails.id, maxID)
            articles.push(...data.articles);
        }
        articles.forEach(a => a.key = path.join(a.published_at ? "" : "drafts", a.handle));
        return blogDetails;
    }

    async pullBlogArticles(destDir = "./shopify", blog=null, force = false, dryrun=false, filter= null) {

        // which blog?
        if (!blog) {
            const blogs = await this.listBlogs();
            return await Promise.all(blogs.map(async b => await this.pullBlogArticles(destDir, b.id, force, dryrun, filter)));
        }

        const blogDetails = await this.listBlogArticles(blog);
        if (!blogDetails) return;

        let articles = blogDetails.articles;

        //todo: turn this into a generator
        const filterDate = Date.parse(filter?.createdAt);
        if (filterDate) {
            articles = articles.filter(item => filterDate >= Date.parse(item.updated_at));
        }

        const blogArticlesDir = path.join(destDir, blogDetails.key);

        const localFiles = new Set();
        for await (const file of getFiles(blogArticlesDir)) {
            localFiles.add(path.relative(blogArticlesDir, file));
        }

        for (const article of articles || []) {
            const filename = path.join(blogArticlesDir, article.key);
            const html = article.body_html || ""; // //TODO: really should .replace(/\u00A0/g, "&nbsp;")
            const key = article.key;
            localFiles.delete(key + ".html");

            const jsonData = stringify(cleanObject(article, BLOGS_IGNORE_ATTRIBUTES));
            const data = ['<script type="application/vnd.api+json">', jsonData, "</script>", html].join('\n');
            if (force || await md5File(filename + ".html") !== md5(data)) {
                console.log(`SAVING: ${blogDetails.key}/${key}.html`);
                if (!dryrun) {
                    await this.#saveFile(filename + ".html", data);
                }
            }
        }

        // we don't delete when filtering
        if (filterDate) localFiles.clear();

        //TODO: delete
        for (const f of localFiles) {
           console.log(`DELETE ${f}`);
            if (!dryrun) fs.unlinkSync(path.join(blogArticlesDir, f));
        }

    }

    async pushBlogArticles(destDir = "./shopify", blog = null, force = false, dryrun=false) {

        // TODO: use local folders instead of remote
        if (!blog) {
            const blogs = await this.listBlogs();
            return await Promise.all(blogs.map(async b => await this.pushBlogArticles(destDir, b.id)));
        }

        // which blog?
        let blogDetails = await this.listBlogArticles(blog);
        if (!blogDetails) {
            blogDetails = await this.shopifyAPI.createBlog({title: blog});
            if (!blogDetails || !blogDetails.blog) return;
            blogDetails = blogDetails.blog;
        }

        const blogArticlesDir = path.join(destDir, blogDetails.key);

        const readBlogArticleFile = (file) => {
            if (!fs.existsSync(file)) return;
            const d = this.#readFile(file);
            const [,jsonRaw,html] = /^\s*<script\s*type="application\/vnd\.api\+json">\s*({[\s\S]*?})\s*<\/script>\s*([\s\S]*)/mi.exec(d);
            const data = JSON.parse(jsonRaw);
            data.body_html = html;
            return data;
        }

        const localFiles = new Set();
        for await (const file of getFiles(blogArticlesDir, /.html$/)) {
            localFiles.add(path.relative(blogArticlesDir, file).replace(/\.html$/,""));
        }

        const updateBlogArticle = new Set();
        const deleteBlogArticles = new Set();

        for (const remoteArticle of blogDetails.articles) {
            const handle = remoteArticle.handle;
            const draftHandle = path.join("drafts", handle);

            if (localFiles.has(handle) || localFiles.has(draftHandle)) {
                updateBlogArticle.add([handle || draftHandle, remoteArticle]); //TODO: clean this up
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
            delete blogArticle.id; // ensure new articles don't have an id
            blogArticle.handle = ShopifyCore.handleName(file.replace(/drafts[\/\\]/, ""));
            blogArticle.published = !file.startsWith("drafts");
            if (!blogArticle.published) delete blogArticle.published_at;

            console.log(`CREATE blogs/${blogDetails.handle}/${file}`);
            await this.shopifyAPI.createBlogArticle(blogArticle);
        }));
        // Updates
        await Promise.all([...updateBlogArticle].map(async update => {
            const [file, remoteArticle] = update;
            // Local file matches, is this a CREATE or UPDATE?
            const blogArticle = readBlogArticleFile(path.join(blogArticlesDir, file + ".html")) || readBlogArticleFile(path.join(blogArticlesDir, "drafts", file + ".html"));

            //if the file exists in both drafts and published, we bias to the published entry
            blogArticle.published = !file.startsWith("drafts");
            if (!blogArticle.published) delete blogArticle.published_at; // not enough just to say it is not published

            //normalize the basics
            blogArticle.id = remoteArticle.id; //copy over the ID just in case it has drifted locally
            blogArticle.blog_id = blogDetails.id;
            blogArticle.handle = ShopifyCore.handleName(file);

            // remote doesn't say published = true
            remoteArticle.published = !!remoteArticle.published_at;
            if (!isSame(remoteArticle, blogArticle, PAGES_IGNORE_ATTRIBUTES_EXT)) {
                console.log(`UPDATE blogs/${blogDetails.handle}/${file}`);
                await this.shopifyAPI.updateBlogArticle(blogArticle.id, blogArticle);
            }
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
    async listMenus(baseDir = "menus") {
        let data = null;
        const menus = [];
        while (!data || data.menus.length  === 250) {
            const maxID = Math.max(0, ...menus.map(r => r.id));
            data = await this.shopifyAPI.getMenus(maxID);
            menus.push(...data.menus);
        }
        menus.forEach(b => b.key = path.join(baseDir, b.handle));
        return menus;
    }

    async pullMenus(destDir = "./shopify", force = false, dryrun=false, filter= null) {
        let menus = await this.listMenus().catch();
        if (!menus) return;

        //todo: turn this into a generator
        const filterDate = Date.parse(filter?.createdAt);
        if (filterDate) {
            menus = menus.filter(item => filterDate >= Date.parse(item.updated_at));
        }

        const blogs = await this.listBlogArticles();
        const articleMap = new Map(blogs.map(b => b.articles?.map(a => [a.id, b.handle + "/" + a.handle])).flat());
        const menuToYml = function(currItems = [], indent = "") {
            return currItems.map(item => {
                let value = item.title;
                // each menu type requires a slightly different formatting for the url
                // TODO: push this up to the model

                // frontpage, http, search
                if (/^(?:https?:|mailto:)?[/]/i.test(item.subject)) {
                    value = `[${value}](${item.subject})`;
                }
                // collection, product, catalog, page, blog
                else if (item.type === "blog" || item.type === "collection" || item.type === "page" || item.type === "product") {
                    const target = item.type + "s";
                    value = `[${value}](/${target}/${item.subject})`;
                }
                // shop_policy,
                else if (item.type === "shop_policy") {
                    value = `[${value}](/policies/${item.subject})`;
                }
                // article
                else if (item.type === "article") {
                    const blog = articleMap.get(item.subject_id);
                    if (path) {
                        value = `[${value}](/blogs/${blog}/${item.subject})`;
                    }
                }
                return [`${indent}- ${value}`, menuToYml(item.items, "  " + indent)]
            });
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

        // we don't delete when filtering
        if (filterDate) localFiles.clear();

        //TODO: delete
        for (const f of localFiles) {
           console.log(`DELETE ${f}`);
            if (!dryrun) fs.unlinkSync(path.join(destDir, f));
        }

        return menus;
    }

    //
    // Products
    //
    async listProducts(baseDir = "products") {
        let data = null;
        const items = [];
        while (!data || data.products.length  === 250) {
            const maxID = Math.max(0, ...items.map(r => r.id));
            data = await this.shopifyAPI.getProducts(maxID);
            items.push(...data.products);
        }
        items.forEach(o => o.key = path.join(baseDir, o.handle));
        items.forEach(o => o.images?.forEach(i => {
            const [,handle] = i.src?.match(/^(?:https?:\/\/[^\/]+)?[^?]*\/([^\/?]*)(?:\?.*)?$/) || [];
            i.handle = handle;
            i.key = path.join(o.key, i.handle)
        }));
        return items;
    }


    async pullProducts(destDir = "./shopify", force = false, dryrun=false, filter= null) {
        //todo: turn this into a generator
        let products = await this.listProducts();

        const filterDate = new Date(filter?.createdAt).getTime();
        if (filterDate) { // filterDate === 0 or NaN or Null will be false
            products = products.filter(item => filterDate >= new Date(item.created_at).getTime());
            products.forEach(product => {
                product.images = product.images.filter(item => filterDate >= new Date(item.created_at).getTime());
            })
        }

        const valueToCSV = function(value) {
            if (!value) return "";

            if (typeof value === "string") {
                if (/[",\n\r]/.test(value)) {
                    return `"${value.replace(/"/g, '""')}"`;
                }
            }
            else if (typeof value === "object") {
                return `"${stringify(value).replace(/"/g, '""')}"`;
            }
            return value.toString().trim();
        }

        const PRODUCT_CSV_HEADER = [
            "Handle","Title","Body (HTML)","Vendor","Type","Tags","Published",
            "Option1 Name","Option1 Value","Option2 Name","Option2 Value","Option3 Name","Option3 Value",
            "Variant SKU",
            // "Variant Grams",
            // "Variant Inventory Tracker",
            "Variant Inventory Policy","Variant Fulfillment Service",
            "Variant Price","Variant Compare At Price","Variant Requires Shipping","Variant Taxable","Variant Barcode",
            "Image Src",
            // "Image Position",
            "Image Alt Text",
            // "Gift Card","SEO Title","SEO Description","Google Shopping / Google Product Category","Google Shopping / Gender",
            // "Google Shopping / Age Group","Google Shopping / MPN","Google Shopping / AdWords Grouping","Google Shopping / AdWords Labels",
            // "Google Shopping / Condition","Google Shopping / Custom Product","Google Shopping / Custom Label 0","Google Shopping / Custom Label 1",
            // "Google Shopping / Custom Label 2","Google Shopping / Custom Label 3","Google Shopping / Custom Label 4",
            // "Variant Image",
            "Variant Weight",
            "Variant Weight Unit",
            // "Variant Tax Code",
            // "Cost per item",
            "Status"
        ].map(valueToCSV).join(',');

        const csvData = [PRODUCT_CSV_HEADER];

        for (const product of products) {
            product.options = (product.options || []).sort((a, b) => a.position - b.position);
            product.variants = (product.variants || []).sort((a, b) => a.position - b.position);

            const hasVariants = product.options.length > 1
                || (product.options[0] && (product.options[0])?.name !== "Title") //TODO: what if product.options is null?
                || (product.options[0] && (product.options[0])?.values[0] !== "Default Title");

            for (const variant of product.variants || []) {
                csvData.push(
                    [
                        product.handle,
                        product.title,
                        product.body_html,
                        product.vendor,
                        product.product_type,
                        product.tags,
                        Boolean(!!product.published_at),
                        hasVariants ? product.options[0]?.name : null,
                        hasVariants ? variant.option1 : null,
                        product.options[1]?.name,
                        variant.option2,
                        product.options[2]?.name,
                        variant.option3,
                        variant.sku,
                        // variant.grams,
                        // "Variant Inventory Tracker",
                        variant.inventory_policy,
                        variant.fulfillment_service,
                        variant.price,
                        variant.compare_at_price,
                        variant.requires_shipping,
                        Boolean(variant.taxable),
                        variant.barcode,
                        product.images?.map(i => i.src).join("\n"),
                        // product.image?.position,
                        product.images?.map(i => i.alt ?? "").join("\n").trim(),
                        // "Gift Card",
                        // "SEO Title",
                        // "SEO Description",
                        // "Google Shopping / Google Product Category",
                        // "Google Shopping / Gender",
                        // "Google Shopping / Age Group",
                        // "Google Shopping / MPN",
                        // "Google Shopping / AdWords Grouping",
                        // "Google Shopping / AdWords Labels",
                        // "Google Shopping / Condition",
                        // "Google Shopping / Custom Product",
                        // "Google Shopping / Custom Label 0",
                        // "Google Shopping / Custom Label 1",
                        // "Google Shopping / Custom Label 2",
                        // "Google Shopping / Custom Label 3",
                        // "Google Shopping / Custom Label 4",
                        // "Variant Image",
                        product.images?.filter(i => i.id === variant.image_id).map(i => i.src)[0],
                        variant.weight, //TODO: not standard in CSV export
                        variant.weight_unit,
                        // "Variant Tax Code",
                        // "Cost per item",
                        // variant.inventory_management,
                        // variant.inventory_quantity,
                        // variant.old_inventory_quantity
                        variant.status,
                    ].map(valueToCSV).join(',')
                )
            }
        }
        const data = csvData.join('\n');
        const filename = path.join(destDir, "products", "products.csv");

        if (force || await md5File(filename) !== md5(data)) {
            console.log(`SAVING: products.csv`);
            if (!dryrun) await this.#saveFile(filename, data);
        }

        await Promise.all(products.map(async product =>
            Promise.all(product.images.map(async image => {
                // most likely in the format of: https://cdn.shopify.com/s/files/1/0716/7497/products/other-stuff-wood-soap-dish-2.jpg?v=1605121789
                const [,file,v] = image.src?.match(/^(?:https?:\/\/[^\/]+)?[^?]*\/([^\/?]*)(?:\?.*(?:v=(\d+)))?$/) || []
                try {
                    const head = await fetch(image.src, {method: "HEAD"});
                    const remoteBytes = head.headers.get('content-length');
                    const localFilename = path.join(destDir, "products", product.handle, file);

                    if (force || !await this.#isAssetSame(localFilename, null, image.updated_at, remoteBytes)) {
                        const res = await this.shopifyAPI.getURL(image.src);
                        console.log(`SAVING: ${path.join("products", product.handle, file)}`);
                        if (!dryrun) await this.#saveFile(localFilename, res);
                    }
                }
                catch (e) {
                    console.error(`ERROR: ${image.src}`);
                    console.error(e);
                }
            }
        ))));
        return products;
    }
}

module.exports = ShopifyCore;
