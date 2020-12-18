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

function cmdToOptions(options, theme) {
    program.assets = false
    program.menus = false
    program.redirects = false
    program.scripts = false
    program.pages = false
    program.blogs = false
    program[options.parent?.args[0] || 'assets'] = true;

    if (theme) options.parent.theme = theme;
    return options.parent;
}

async function list(theme, options) {
    const shopify = getShopify();
    if ((options.parent?.args[0] === "list" && !theme)
        || options.parent?.args[0] === "themes") {
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
        if (program.scripts) {
            const scripts = await shopify.listScriptTags();
            scripts.forEach(item => console.log(`${item.src}`));
        }
        if (program.menus) {
            const menus = await shopify.listMenus().catch(e => {}) || [];
            menus.forEach(item => console.log(`${item.key}`));
        }
        if (program.redirects) {
            const redirects = await shopify.listRedirects();
            redirects.forEach(item => console.log(`${item.path} => ${item.target}`));
        }
        if (program.pages) {
            const pages = await shopify.listPages();
            pages.forEach(item => console.log(`${item.key}.html`));
        }
        if (program.blogs) {
            const blogArticles = await shopify.listBlogArticles();
            blogArticles.forEach(blog => blog.articles.forEach(item => console.log(`${blog.key}/${item.key}.html`)));
        }
    }
}

async function pull(options) {
    const shopify = getShopify();
    const filter = {
        createdAt: options.filterCreated
    }
    if (program.assets) await shopify.pullAssets(options.theme, program.outputDir, options.force, options.dryrun, filter);
    if (program.scripts) await shopify.pullScriptTags(program.outputDir, options.force, options.dryrun, filter);
    if (program.menus) await shopify.pullMenus(program.outputDir, options.force, options.dryrun, filter);
    if (program.redirects && !options.filterCreated) await shopify.pullRedirects(program.outputDir, options.force, options.dryrun);
    if (program.pages) await shopify.pullPages(program.outputDir, options.force, options.dryrun, filter);
    if (program.blogs) await shopify.pullBlogArticles(program.outputDir, null, options.force, options.dryrun, filter);
}

async function push(options) {
    const shopify = getShopify();
    await shopify.initTheme(options.theme);
    if (program.assets) await shopify.pushAssets(options.theme, program.outputDir);
    if (program.scripts) await shopify.pushScriptTags(program.outputDir);
    // if (program.menus) await shopify.pushMenus(program.outputDir);
    if (program.redirects) await shopify.pushRedirects(program.outputDir);
    if (program.pages) await shopify.pushPages(program.outputDir);
    if (program.blogs) await shopify.pushBlogArticles(program.outputDir);
}

async function publish(options) {
    const shopify = getShopify();
    await shopify.publishTheme(options.theme);
}

async function init(theme, options) {
    const shopify = getShopify();
    console.log('init');
    const currTheme = await shopify.getTheme(theme);
    const changeSet = await shopify.getChangeSets(theme);

    if (options.simple) {
        [...changeSet.keys()].sort().forEach(k => console.log(k));
    }
    else if (options.details) {
        console.log(Object.fromEntries([...changeSet.entries()].sort()));
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
    .option('--changes', 'show unique change dates', false)
    .option('--details', 'expand the output to include details', false)
    .option('--git', 'expand the output to include details', false)
    .action(list);
listCmd.command('themes').action(options => list(null, options));
listCmd.command('assets [theme]').action((theme, options)=>list(theme, cmdToOptions(options)));
listCmd.command('scripts').action(options =>list(null, cmdToOptions(options)));
listCmd.command('menus') .action(options =>list(null, cmdToOptions(options)));
listCmd.command('redirects').action(options => list(null, cmdToOptions(options)));
listCmd.command('pages').action(options => list(null, cmdToOptions(options)));
listCmd.command('blogs').action(options => list(null, cmdToOptions(options)));

const pullCmd = program
    .command('pull')
    .description('pull all remote shopify changes locally')
    .option('--theme <name>', 'use a specific theme (defaults to the theme that is currently active)')
    .option('--force', 'force download all files', false)
    .option('-n, --dry-run', "dont't save files" , false)
    .option('--filter-created <timestamp>', "Only pull files present at given timestamp")
    .action(pull);
pullCmd.command('assets [theme]').action((theme, options) => pull(cmdToOptions(options, theme)));
pullCmd.command('scripts').action(options => pull(cmdToOptions(options)));
pullCmd.command('menus') .action(options => pull(cmdToOptions(options)));
pullCmd.command('redirects').action(options => pull(cmdToOptions(options)));
pullCmd.command('pages').action(options => pull(cmdToOptions(options)));
pullCmd.command('blogs').action(options => pull(cmdToOptions(options)));

program
    .command('push')
    .description('push all local changes up to shopify')
    .option('--theme <name>', 'use a specific theme (defaults to the theme that is currently active)')
    .option('--zip <file>', 'use a zip file as the basis for the new theme (instead of the local filesystem)')
    .option('--force', 'force download all files', false)
    .option('-n, --dry-run', "dont't save files" , false)
    .action(push);

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
