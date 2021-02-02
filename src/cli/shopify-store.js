#!/usr/bin/env node
const program = require('commander');
const path = require('path');
const child_process = require('child_process');
const os = require("os");
const Shopify = require('../shopify-core');
const {sleep} = require('../utils');

// sometimes when running in the shell, SIGINT doesn't trip on ^C
const TERMINATE_ACTIONS = [(sig = 0) => {console.log('Done.'); process.exit(sig)}];
async function terminate(...args) {
    if (TERMINATE_ACTIONS.length === 0) return;

    // poor person's debounce
    const actions = [...TERMINATE_ACTIONS];
    TERMINATE_ACTIONS.length = 0;

    console.log();
    const sig = args.unshift();
    for (const action of actions) {
        await action(sig);
    }
    // is this safe, even on beforeExit?
    // process.exitCode = args.unshift() || 0;
    // process.exit(args.unshift() || 0);
}
[
    'SIGABRT','SIGBUS', 'SIGFPE', 'SIGUSR1',
    'SIGSEGV', 'SIGHUP', 'SIGINT', 'SIGQUIT',
    'SIGILL', 'SIGTRAP', 'SIGUSR2', 'SIGTERM'
].forEach(sig => process.on(sig, terminate));

let _shopify = new Shopify();
function getShopify() {
    //TODO: allow the cli to set the auth options
    return _shopify;
}

function setCommand(command) {
    const options = program.opts();
    if (options.hasOwnProperty(command.name())) {
        options.assets = false
        options.menus = false
        options.redirects = false
        options.scripts = false
        options.pages = false
        options.blogs = false
        options[command?.name() || 'assets'] = true;
    }
}

async function getGitBranch(cwd) {
    try {
        return child_process.execFileSync('git', ["symbolic-ref", "--short", "HEAD"], { cwd });
    }
    catch {}
    return null;
}

async function gitCommit(cwd, message = "Sync with Shopify", commitDate = null) {
    const execOptions = {
        cwd: program.opts().outputDir,
        stdio: 'inherit',
    }

    if (commitDate) {
        execOptions.env = Object.assign({
            'GIT_COMMITTER_DATE': commitDate,
            'GIT_AUTHOR_DATE': commitDate
        }, process.env)
    }

    try {
        child_process.execFileSync('git', ['add', '-A'], execOptions);
        child_process.execFileSync('git', ['commit', '--allow-empty', '-a', '-m', message], execOptions);
    }
    catch (e) {
        console.error(e);
    }
}

async function list(options, command) {
    const shopify = getShopify();
    if (command?.name()  !== 'list') setCommand(command);
    Object.assign(options, Object.assign(program.opts(), command.parent?.opts(), options));

    if (command?.name() === "themes" || (command?.name()  === 'list' && !options.theme)) {
        //special case where we list themes as default when no them provided and when not running in a sub command
        const themes = await shopify.listThemes();
        for (const theme of themes || []) {
            console.log(`${theme.handle || theme.name}${theme.role === 'main' ? " (ACTIVE)" : ""}`);
        }
    }
    else {
        const currTheme = await shopify.getTheme(options.theme);
        if (options.assets) {
            const themeAssets = await shopify.listAssets(currTheme.id);
            themeAssets.assets.forEach(item => console.log(`${item.key}`));
        }
        if (options.menus) {
            const menus = await shopify.listMenus().catch(e => {}) || [];
            menus.forEach(item => console.log(`${item.key}`));
        }
        if (options.pages) {
            const pages = await shopify.listPages();
            pages.forEach(item => console.log(`${item.key}.html`));
        }
        if (options.blogs) {
            const blogArticles = await shopify.listBlogArticles();
            blogArticles.forEach(blog => blog.articles.forEach(item => console.log(`${blog.key}/${item.key}.html`)));
        }
        if (options.scripts) {
            const scripts = await shopify.listScriptTags();
            scripts.forEach(item => console.log(`<script src=${item.src}>`));
        }
        if (options.redirects) {
            const redirects = await shopify.listRedirects();
            redirects.forEach(item => console.log(`${item.path} (302) => ${item.target}`));
        }
    }
}

async function pull(options, command) {
    const shopify = getShopify();
    if (command?.name() !== 'pull') setCommand(command);
    Object.assign(options, Object.assign(program.opts(), command.parent?.opts(), options));

    const filter = {
        createdAt: options.filterCreated
    }
    const dryrun = options.dryrun;
    const force = options.force;
    if (options.assets) await shopify.pullAssets(options.theme, options.outputDir, force, dryrun, filter);
    if (options.menus) await shopify.pullMenus(options.outputDir, force, dryrun, filter).catch(e => e); //TODO: fix auth detection
    if (options.pages) await shopify.pullPages(options.outputDir, force, dryrun, filter);
    if (options.blogs) await shopify.pullBlogArticles(options.outputDir, null, force, dryrun, filter);
    // redirects don't retain create/update dates
    if (options.redirects && !filter.createdAt) await shopify.pullRedirects(options.outputDir, force, dryrun);
    if (options.scripts) await shopify.pullScriptTags(options.outputDir, force, dryrun, filter);
}

async function push(options, command) {
    const shopify = getShopify();
    if (options?.name()  !== 'pull') setCommand(options);
    Object.assign(options, Object.assign(program.opts(), command.parent?.opts(), options));

    const dryrun = options.dryrun;
    const force = options.force;

    await shopify.createTheme(options.theme);
    if (options.assets) await shopify.pushAssets(options.theme, options.outputDir, force, dryrun);
    // if (options.menus) await shopify.pushMenus(options.outputDir, force, dryrun);
    if (options.pages) await shopify.pushPages(options.outputDir, force, dryrun);
    if (options.blogs) await shopify.pushBlogArticles(options.outputDir, force, dryrun);
    if (options.redirects) await shopify.pushRedirects(options.outputDir, force, dryrun);
    if (options.scripts) await shopify.pushScriptTags(options.outputDir, force, dryrun);
}

async function publish(options, command) {
    const shopify = getShopify();
    Object.assign(options, Object.assign(program.opts(), command.parent?.opts(), options));
    await shopify.publishTheme(options.theme);
}

async function init(theme, options, command) {
    const shopify = getShopify();
    Object.assign(options, Object.assign(program.opts(), command.parent?.opts(), options));

    console.log('Initializing Local Environment...');
    const currTheme = await shopify.getTheme(theme);
    const changeSet = await shopify.getChangeSets(theme);

    console.log('Calculating Change Sets:');
    if (options.details) {
        console.log(Object.fromEntries([...changeSet.entries()].sort()));
    }
    else if (options.simple) {
        for (const key of [...changeSet.keys()].sort()) {
            console.log(`${key} (${(changeSet.get(key) || []).length})`);
        }
    }

    if (options.git && await getGitBranch(options.outputDir)) {
        for (const createdAt of [...changeSet.keys()].sort()) {
            const filter = { createdAt }

            // determine which themes are needed for this changeset
            // it's a bit of a guess because the exact branching and ancestory isn't known
            const themeNames = new Set(changeSet.get(createdAt)
                .filter(f => /^[a-z0-9._-]+~/.test(f))
                .map(f => f.replace(/~.*/, ""))
                .filter(f => f === currTheme.handle || Date.parse(createdAt) < Date.parse(currTheme.created_at)));

            for (const themeName of [...themeNames]) {
                if (options.assets) await shopify.pullAssets(themeName, options.outputDir, false, false, filter);
            }

            if (options.menus) await shopify.pullMenus(options.outputDir, false, false, filter).catch(e => e); //TODO: fix auth detection
            if (options.pages) await shopify.pullPages(options.outputDir, false, false, filter);
            if (options.blogs) await shopify.pullBlogArticles(options.outputDir, null, false, false, filter);
            if (options.scripts) await shopify.pullScriptTags(options.outputDir, false, false, filter);
            await gitCommit(options.outputDir, `Sync with Shopify @ ${createdAt}`, createdAt);
        }
        await pull(options);
        await gitCommit(options.outputDir, `Sync with Shopify @ ${new Date().toISOString()}`);
    }
}

async function serve(options, command) {
    const shopify = getShopify();
    Object.assign(options, Object.assign(program.opts(), command.parent?.opts(), options));

    console.log('Initializing Local Environment:');
    let themeName = options.themeName ?? `[DEV] ${os.userInfo().username}@${os.hostname}`
    if (!options.themeName && options.git) {
        const gitBranch = await getGitBranch(options.outputDir);
        if (gitBranch) {
            themeName += `/${Buffer.from(gitBranch).toString('UTF-8').trim()}`;
        }
    }

    // create new ephemeral theme
    console.log(`... creating "${themeName}"`);
    await shopify.createTheme(themeName);
    const currTheme = await shopify.getTheme(themeName);
    if (currTheme.role === 'main') {
        console.error('ERROR: Developing on a published theme is not supported');
        return;
    }

    TERMINATE_ACTIONS.unshift(async () => {
        console.log(`... cleanup "${themeName}"`);
        await shopify.deleteTheme(themeName)
    });
    try {
        console.log(`... watching ${options.outputDir}`);

        // push to the theme
        await shopify.watchAssets(themeName, options.outputDir);

        // proxy the theme
        // TODO: create proxy
        console.log(`... preview: https://${shopify.host}/?preview_theme_id=${currTheme.id}`);
        console.log(`Press ^C to exit.`);

        // watch
        while(true) {
            await sleep(100);
        }
    }
    catch(e) {
        console.error(e);
    }
    // 4. register cleanup
    await shopify.deleteTheme(themeName);
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
    .command('list')
    .option('--theme <name>', "Only pull assets related to a theme name")
    .action(list);
    listCmd.command('themes').action(list);
    listCmd.command('assets').action(list);
    listCmd.command('scripts').action(list);
    listCmd.command('menus').action(list);
    listCmd.command('redirects').action(list);
    listCmd.command('pages').action(list);
    listCmd.command('blogs').action(list);

const pullCmd = program
    .command('pull')
    .description('pull all remote shopify changes locally (defaults to the currently active theme)')
    .option('--force', 'force download all files', false)
    .option('-n, --dry-run', "dont't save files" , false)
    .option('--filter-created <timestamp>', "Only pull files present at given timestamp")
    .option('--theme <name>', "Only pull assets related to a theme name")
    .action(pull);
    pullCmd.command('assets').action(pull);
    pullCmd.command('scripts').action(pull);
    pullCmd.command('menus') .action(pull);
    pullCmd.command('redirects').action(pull);
    pullCmd.command('pages').action(pull);
    pullCmd.command('blogs').action(pull);

const pushCmd = program
    .command('push')
    .description('push all local changes up to shopify (defaults to the theme that is currently active)')
    .option('--force', 'force download all files', false)
    .option('-n, --dry-run', "dont't save files" , false)
    .option('--theme <name>', "Only pull assets related to a theme name")
    .action(push);
    pushCmd.command('assets').action(push);
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
    .option('--no-git', 'expand the output to include details', false)
    .action(init);

program
    .command('serve')
    .description('init a new theme on the remote')
    .option('-n, --dry-run', "dont't save files" , false)
    .option('--theme <name>', "specify the ephemeral theme name to use" )
    .option('--no-git', 'disable inspecting git for the branch name')
    .action(serve);

program
    .command('publish')
    .description('publish (make active) a given theme')
    .option('--theme <name>', "specify the ephemeral theme name to use" )
    .action(publish);

if (process.argv.indexOf("--debug") === -1) console.debug = function () {};
if (process.argv.indexOf("--verbose") === -1 && process.argv.indexOf("--debug") === -1) console.info = function () {};

program.parseAsync(); // end with parse to parse through the input
