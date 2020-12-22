#!/usr/bin/env node
const program = require('commander');
const path = require('path');
const child_process = require('child_process');
const Shopify = require('./shopify');

process.on('SIGINT', function () {
    process.exit(1);
});

let _shopify = new Shopify();
function getShopify() {
    //TODO: allow the cli to set the auth options
    return _shopify;
}

function setCommand(options, theme) {
    if (program.hasOwnProperty(options.name())) {
        program.assets = false
        program.menus = false
        program.redirects = false
        program.scripts = false
        program.pages = false
        program.blogs = false
        program[options?.name() || 'assets'] = true;
    }
}

async function list(theme, options) {
    const shopify = getShopify();
    if (!options && !!theme) { options = theme; theme = null }
    if (options?.name()  !== 'list') setCommand(options);

    if (options?.name() === "themes" || (options?.name()  === 'list' && !theme)) {
        //special case where we list themes as default when no them provided and when not running in a sub command
        const themes = await shopify.listThemes();
        for (const theme of themes || []) {
            console.log(`${theme.handle || theme.name}${theme.role === 'main' ? " (ACTIVE)" : ""}`);
        }
    }
    else {
        const currTheme = await shopify.getTheme(theme);
        if (program.assets) {
            const themeAssets = await shopify.listAssets(currTheme.id);
            themeAssets.assets.forEach(item => console.log(`${item.key}`));
        }
        if (program.menus) {
            const menus = await shopify.listMenus().catch(e => {}) || [];
            menus.forEach(item => console.log(`${item.key}`));
        }
        if (program.pages) {
            const pages = await shopify.listPages();
            pages.forEach(item => console.log(`${item.key}.html`));
        }
        if (program.blogs) {
            const blogArticles = await shopify.listBlogArticles();
            blogArticles.forEach(blog => blog.articles.forEach(item => console.log(`${blog.key}/${item.key}.html`)));
        }
        if (program.scripts) {
            const scripts = await shopify.listScriptTags();
            scripts.forEach(item => console.log(`<script src=${item.src}>`));
        }
        if (program.redirects) {
            const redirects = await shopify.listRedirects();
            redirects.forEach(item => console.log(`${item.path} (302) => ${item.target}`));
        }
    }
}

async function pull(theme, options) {
    const shopify = getShopify();

    if (!options && !!theme) { options = theme; theme = null }
    if (options?.name()  !== 'pull') setCommand(options);

    const filter = {
        createdAt: options.filterCreated ?? options.parent.filterCreated
    }
    const dryrun = options.dryrun ?? options.parent.dryrun;
    const force = options.force ?? options.parent.force;

    if (program.assets) await shopify.pullAssets(theme, program.outputDir, force, dryrun, filter);
    if (program.menus) await shopify.pullMenus(program.outputDir, force, dryrun, filter);
    // redirects don't retain create/update dates
    if (program.pages) await shopify.pullPages(program.outputDir, force, dryrun, filter);
    if (program.blogs) await shopify.pullBlogArticles(program.outputDir, null, force, dryrun, filter);
    if (program.redirects && !filter.createdAt) await shopify.pullRedirects(program.outputDir, force, dryrun);
    if (program.scripts) await shopify.pullScriptTags(program.outputDir, force, dryrun, filter);
}

async function push(theme, options) {
    const shopify = getShopify();
    if (!options && !!theme) { options = theme; theme = null }
    if (options?.name()  !== 'pull') setCommand(options);

    const dryrun = options.dryrun ?? options.parent.dryrun;
    const force = options.force ?? options.parent.force;

    await shopify.initTheme(options.theme);
    if (program.assets) await shopify.pushAssets(options.theme, program.outputDir, force, dryrun);
    // if (program.menus) await shopify.pushMenus(program.outputDir, force, dryrun);
    if (program.pages) await shopify.pushPages(program.outputDir, force, dryrun);
    if (program.blogs) await shopify.pushBlogArticles(program.outputDir, force, dryrun);
    if (program.redirects) await shopify.pushRedirects(program.outputDir, force, dryrun);
    if (program.scripts) await shopify.pushScriptTags(program.outputDir, force, dryrun);
}

async function publish(options) {
    const shopify = getShopify();
    await shopify.publishTheme(options.theme);
}

async function init(theme, options) {
    const shopify = getShopify();
    console.log('Initializing Local Environment...');
    const currTheme = await shopify.getTheme(theme);
    const changeSet = await shopify.getChangeSets(theme);

    console.log('Calculating Change Sets:');
    if (options.details) {
        console.log(Object.fromEntries([...changeSet.entries()].sort()));
    }
    else {
        [...changeSet.keys()].sort().forEach(k => console.log(`${k} (${(changeSet.get(k) || []).size})`));

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
                if (program.assets) await shopify.pullAssets(themeName, program.outputDir, false, false, filter);
            }

            if (program.menus) await shopify.pullMenus(program.outputDir, false, false, filter);
            if (program.pages) await shopify.pullPages(program.outputDir, false, false, filter);
            if (program.blogs) await shopify.pullBlogArticles(program.outputDir, null, false, false, filter);
            if (program.scripts) await shopify.pullScriptTags(program.outputDir, false, false, filter);
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
    await pull(options);
}

program
    .version('1.0');

program
    .option('--debug', 'enable debug', false)
    .option('--verbose', 'enable verbose', false)
    .option('--outputDir <dir>', 'location to save the store files', "./")
    .option('--no-themecheck', 'By default, only the active theme will push changes to redirects, scripts, pages and blogs. Disable theme-check to always push, even on inactive themes', false)
    .option('--no-assets', 'disable pushing assets', false)
    .option('--no-scripts', 'disable pushing scripts', false)
    .option('--no-menus', 'disable pushing redirects', false)
    .option('--no-redirects', 'disable pushing redirects', false)
    .option('--no-pages', 'disable pushing pages', false)
    .option('--no-blogs', 'disable pushing blogs', false);


const listCmd = program
    .command('list [theme]')
    .action(list);
listCmd.command('themes').action(list);
listCmd.command('assets [theme]').action(list);
listCmd.command('scripts').action(list);
listCmd.command('menus').action(list);
listCmd.command('redirects').action(list);
listCmd.command('pages').action(list);
listCmd.command('blogs').action(list);

const pullCmd = program
    .command('pull [theme]')
    .description('pull all remote shopify changes locally (defaults to the currently active theme)')
    .option('--force', 'force download all files', false)
    .option('-n, --dry-run', "dont't save files" , false)
    .option('--filter-created <timestamp>', "Only pull files present at given timestamp")
    .action(pull);
pullCmd.command('assets [theme]').action(pull);
pullCmd.command('scripts').action(pull);
pullCmd.command('menus') .action(pull);
pullCmd.command('redirects').action(pull);
pullCmd.command('pages').action(pull);
pullCmd.command('blogs').action(pull);

const pushCmd = program
    .command('push [theme]')
    .description('push all local changes up to shopify (defaults to the theme that is currently active)')
    .option('--zip <file>', 'use a zip file as the basis for the new theme (instead of the local filesystem)')
    .option('--force', 'force download all files', false)
    .option('-n, --dry-run', "dont't save files" , false)
    .action(push);
pushCmd.command('assets [theme]').action(push);
pushCmd.command('scripts').action(push);
pushCmd.command('menus') .action(push);
pushCmd.command('redirects').action(push);
pushCmd.command('pages').action(push);
pushCmd.command('blogs').action(push);


program
    .command('init <theme>')
    .description('init a new theme on the remote')
    .option('--simple', 'show expand the output to include details', false)
    .option('--details', 'expand the output to include details', false)
    .option('-n, --dry-run', "dont't save files" , false)
    .option('--git', 'expand the output to include details', false)
    .action(init);

program
    .command('publish <theme>')
    .description('publish (make active) a given theme')
    .action(publish);

if (process.argv.indexOf("--debug") === -1) console.debug = function () {};
if (process.argv.indexOf("--verbose") === -1 && process.argv.indexOf("--debug") === -1) console.info = function () {};

program.parse(process.argv); // end with parse to parse through the input
if (process.argv.length <= 2) program.help();
