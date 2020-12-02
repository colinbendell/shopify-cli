#!/usr/bin/env node
const program = require('commander');
const Shopify = require('./shopify');

process.on('SIGINT', function () {
    process.exit(1);
});

function init() {
    return new Shopify();
}

async function list() {
    const shopify = init();
    const res = await shopify.list();
    for (const theme of res.themes || []) {
        console.log(`${theme.name}${theme.role === 'main' ? " (main)" : ""}`);
    }
}

async function pull(options) {
    const shopify = init();
    if (options.assets) await shopify.pullAssets(options.theme, program.onlinestore);
    if (options.redirects) await shopify.pullRedirects(program.outputDir);
    if (options.scripttags) await shopify.pullScriptTags(program.outputDir);
    // console.log(res);
    // for (const asset of res.assets || []) {
    //     console.log(`${asset.key}`);
    // }
}

program
    .version('1.0');

program
    .option('--debug', 'enable debug', false)
    .option('--verbose', 'enable verbose', false)
    .option('--outputDir <dir>', 'location to save the store files', "./shopify");

program
    .command('list')
    .action(list);

program
    .command('pull')
    .option('--no-assets', 'disable pulling assets', false)
    .option('--no-redirects', 'disable pulling redirects', false)
    .option('--no-scripttags', 'disable pulling scripts', false)
    .action(pull);

if (process.argv.indexOf("--debug") === -1) console.debug = function () {};
if (process.argv.indexOf("--verbose") === -1 && process.argv.indexOf("--debug") === -1) console.info = function () {};

program.parse(process.argv); // end with parse to parse through the input
if (process.argv.length <= 2) program.help();
