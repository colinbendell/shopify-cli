#!/usr/bin/env node
const program = require('commander');
const path = require('path');
const Shopify = require('./shopify');

process.on('SIGINT', function () {
    process.exit(1);
});

function init() {
    return new Shopify();
}

async function list(theme, options) {
    const shopify = init();
    if (!theme) {
        const res = await shopify.listThemes();
        for (const theme of res.themes || []) {
            console.log(`${theme.name}${theme.role === 'main' ? " (main)" : ""}`);
        }
    }
    else {
        const assets = await shopify.listAssets(theme, options.changes);
        const pages = await shopify.listPages();
        const blogArticles = await shopify.listBlogArticles();
        const scriptTags = await shopify.listScriptTags();
        const menus = await shopify.listMenus();
        if (options.changes) {
            const changeSet = new Map();
            // const d = new Map();

            for (const asset of assets || []) {
                if (!asset.versions || asset.versions.length === 0) {
                    // use updated_at not created_at since @v created_at might not available
                    const createdDate = new Date(asset.updated_at).toISOString();
                    if (!changeSet.has(createdDate)) changeSet.set(createdDate, []);
                    changeSet.get(createdDate).push(asset.key);
                }
                for (const version of asset.versions || []) {
                    const versionDate = new Date(Date.parse(version.created_at) || 0).toISOString();
                    // if (!d.has(versionDate)) d.set(versionDate, []);
                    // d.get(versionDate).push(asset.key + "@" + version.version);
                    if (!changeSet.has(versionDate)) changeSet.set(versionDate, []);
                    changeSet.get(versionDate).push(asset.key + "@" + version.version);
                }
            }
            for (const page of pages || []) {
                // use updated_at not created_at since @v created_at might not available
                const createdDate = new Date(page.updated_at).toISOString();
                if (!changeSet.has(createdDate)) changeSet.set(createdDate, []);
                changeSet.get(createdDate).push(page.key + ".html");
            }
            for (const blog of blogArticles || []) {
                for (const article of blog.articles || []) {
                    // use updated_at not created_at since @v created_at might not available
                    const createdDate = new Date(article.updated_at).toISOString();
                    if (!changeSet.has(createdDate)) changeSet.set(createdDate, []);
                    changeSet.get(createdDate).push(path.join(blog.key, article.key + ".html"));
                }
            }
            for (const script of scriptTags || []) {
                // use updated_at not created_at since @v created_at might not available
                const createdDate = new Date(script.updated_at).toISOString();
                if (!changeSet.has(createdDate)) changeSet.set(createdDate, []);
                changeSet.get(createdDate).push(script.src);
            }
            for (const menu of menus || []) {
                // use updated_at not created_at since @v created_at might not available
                const createdDate = new Date(menu.updated_at).toISOString();
                if (!changeSet.has(createdDate)) changeSet.set(createdDate, []);
                changeSet.get(createdDate).push(menu.key);
            }
            let prev = 0;
            for (const curr of [...changeSet.keys()].sort()) {
                if (Date.parse(curr) - Date.parse(prev) <= 60*1000) {
                    const left = changeSet.get(prev);
                    const leftClean = new Set(left.map(v => v.replace(/@\d+$/, "")));

                    const right = changeSet.get(curr);
                    const mergeable = !right.reduce((found, entry) => found || leftClean.has(entry.replace(/@\d+$/, "")), false)
                    if (mergeable) {
                        changeSet.set(curr, left.concat(right));
                        changeSet.delete(prev);
                    }
                }
                prev = curr;
            }
            // console.log(new Map([...d.entries()].sort()));
            console.log(new Map([...changeSet.entries()].sort()));
            // for (const changeDate of [...d.keys()].sort()) {
            //     console.log(`${changeDate}`);
            // }
        }
        else {
            for (const asset of assets || []) {
                console.log(`${asset.key}`);
            }
        }
    }
}

async function pull(options) {
    const shopify = init();
    if (options.assets) await shopify.pullAssets(options.theme, program.outputDir, options.force, options.dryrun);
    if (options.redirects) await shopify.pullRedirects(program.outputDir);
    if (options.scripttags) await shopify.pullScriptTags(program.outputDir);
    if (options.pages) await shopify.pullPages(program.outputDir);
    if (options.blogs) await shopify.pullBlogArticles(program.outputDir);
}

async function push(options) {
    const shopify = init();
    if (options.assets) await shopify.pushAssets(options.theme, program.outputDir);
    if (options.redirects) await shopify.pushRedirects(program.outputDir);
    if (options.scripttags) await shopify.pushScriptTags(program.outputDir);
    if (options.pages) await shopify.pushPages(program.outputDir);
}

async function publish(options) {
    const shopify = init();
    await shopify.publishTheme(options.theme);
}

async function initTheme(theme, options) {
    const shopify = init();
    console.log('init');
    await shopify.initTheme(theme);
}

program
    .version('1.0');

program
    .option('--debug', 'enable debug', false)
    .option('--verbose', 'enable verbose', false)
    .option('--outputDir <dir>', 'location to save the store files', "./");

program
    .command('list [theme]')
    .option('--changes', 'show unique change dates', false)
    .action(list);

program
    .command('pull')
    .description('pull all remote shopify changes locally')
    .option('--theme <name>', 'use a specific theme (defaults to the theme that is currently active)')
    .option('--force', 'force download all files', false)
    .option('--no-themecheck', 'By default only the active theme will pull changes to redirects, scripts, pages and blogs. Disable theme-check to always pull, even on inactive themes', false)
    .option('--no-assets', 'disable pulling assets', false)
    .option('--no-redirects', 'disable pulling redirects', false)
    .option('--no-scripttags', 'disable pulling scripts', false)
    .option('--no-pages', 'disable pulling pages', false)
    .option('--no-menus', 'disable pulling menus', false)
    .option('--no-blogs', 'disable pulling blogs', false)
    .action(pull);

program
    .command('push')
    .description('push all local changes up to shopify')
    .option('--theme <name>', 'use a specific theme (defaults to the theme that is currently active)')
    .option('--force', 'force upload all files', false)
    .option('--no-themecheck', 'By default, only the active theme will push changes to redirects, scripts, pages and blogs. Disable theme-check to always push, even on inactive themes', false)
    .option('--no-assets', 'disable pushing assets', false)
    .option('--no-redirects', 'disable pushing redirects', false)
    .option('--no-scripttags', 'disable pushing scripts', false)
    .option('--no-pages', 'disable pushing pages', false)
    .option('--no-blogs', 'disable pushing blogs', false)
    .action(push);

program
    .command('init <theme>')
    .description('init a new theme on the remote')
    .option('--zip <file>', 'use a zip file as the basis for the new theme')
    .action(initTheme);

program
    .command('publish <theme>')
    .description('publish (make active) a given theme')
    .action(publish);

if (process.argv.indexOf("--debug") === -1) console.debug = function () {};
if (process.argv.indexOf("--verbose") === -1 && process.argv.indexOf("--debug") === -1) console.info = function () {};

program.parse(process.argv); // end with parse to parse through the input
if (process.argv.length <= 2) program.help();
