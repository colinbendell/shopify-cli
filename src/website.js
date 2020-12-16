#!/usr/bin/env node
const program = require('commander');
const path = require('path');
const child_process = require('child_process');
const Shopify = require('./shopify');

process.on('SIGINT', function () {
    process.exit(1);
});

function init() {
    return new Shopify();
}

async function list(theme, options) {
    const shopify = init();
    const themes = await shopify.listThemes();
    if (!theme && !options.changes) {
        for (const theme of themes || []) {
            console.log(`${theme.handle || theme.name}${theme.role === 'main' ? " :main" : ""} (${theme.created_at})`);
        }
    }
    else {
        const currTheme = await shopify.getTheme(theme);

        if (options.changes) {
            const changeSet = await shopify.getChangeSets(theme);
            if (options.details) {
                console.log(Object.fromEntries([...changeSet.entries()].sort()));
            }
            else {
                [...changeSet.keys()].sort().forEach(k => console.log(k));
            }
            if (options.git) {
                const options = {
                    cwd: program.outputDir,
                    stdio: 'inherit',
                }
                for (const createdAt of [...changeSet.keys()].sort()) {
                    const filter = { createdAt }

                    // determine which themes are needed for this changeset
                    // it's a bit of a guess because the exact branching and ancestory isn't known
                    const themeNames = new Set(changeSet.get(createdAt)
                        .filter(f => /^[a-z0-9._-]+~/.test(f))
                        .map(f => f.replace(/~.*/, ""))
                        .filter(f => f === currTheme.handle || Date.parse(createdAt) < Date.parse(currTheme.created_at)));

                    for (const themeName of [...themeNames]) {
                        await shopify.pullAssets(themeName, program.outputDir, false, false, filter);
                    }

                    await shopify.pullMenus(program.outputDir, false, false, filter);
                    await shopify.pullPages(program.outputDir, false, false, filter);
                    await shopify.pullBlogArticles(program.outputDir, null, false, false, filter);
                    await shopify.pullScriptTags(program.outputDir, false, false, filter);
                    options.env = Object.assign({
                        'GIT_COMMITTER_DATE': createdAt,
                        'GIT_AUTHOR_DATE': createdAt
                    }, process.env)
                    try {
                        child_process.execFileSync('git', ['add', '-A'], options)
                        child_process.execFileSync('git', ['commit', '--allow-empty', '-a', '-m', `Sync with Shopify @ ${createdAt}`], options)
                    }
                    catch (e) {
                        console.error(e);
                    }

                }
            }
        }
        else {
            const currTheme = await shopify.getTheme(theme);
            const themeAssets = await shopify.listAssets(currTheme.id, options.changes);

            themeAssets.assets.forEach(item => console.log(`${item.key}`));
            const menus = await shopify.listMenus().catch(e => {}) || [];
            menus.forEach(item => console.log(`${item.key}`));
            const pages = await shopify.listPages();
            pages.forEach(item => console.log(`${item.key}.html`));
            const blogArticles = await shopify.listBlogArticles();
            blogArticles.forEach(blog => pages.forEach(item => console.log(`${blog.key}/${item.key}.html`)));
            const scriptTags = await shopify.listScriptTags();
            scriptTags.forEach(item => console.log(`${item.src}`));
            const redirects = await shopify.listRedirects();
            redirects.forEach(item => console.log(`${item.path}`));
        }
    }
}

async function pull(options) {
    const shopify = init();
    const filter = {
        createdAt: options.filterCreated
    }
    if (options.assets) await shopify.pullAssets(options.theme, program.outputDir, options.force, options.dryrun, filter);
    if (options.redirects && !options.filterCreated) await shopify.pullRedirects(program.outputDir, options.force, options.dryrun);
    if (options.menus) await shopify.pullMenus(program.outputDir, options.force, options.dryrun, filter);
    if (options.pages) await shopify.pullPages(program.outputDir, options.force, options.dryrun, filter);
    if (options.blogs) await shopify.pullBlogArticles(program.outputDir, null, options.force, options.dryrun, filter);
    if (options.scripttags) await shopify.pullScriptTags(program.outputDir, options.force, options.dryrun, filter);
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
    .option('--details', 'expand the output to include details', false)
    .option('--git', 'expand the output to include details', false)
    .action(list);

program
    .command('pull')
    .description('pull all remote shopify changes locally')
    .option('--theme <name>', 'use a specific theme (defaults to the theme that is currently active)')
    .option('--force', 'force download all files', false)
    .option('--dryrun', "dont't save files" , false)
    .option('--filter-created <timestamp>', "Only pull files present at given timestamp")
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
