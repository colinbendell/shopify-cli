#!/usr/bin/env node
const program = require('commander');
const {stringify} = require('../stringify');
const Shopify = require('../shopify-core');

process.on('SIGINT', function () {
    process.exit(1);
});

let _shopify = new Shopify();
function getShopify() {
    //TODO: allow the cli to set the auth options
    return _shopify;
}

async function list() {
    const shopify = getShopify();

    const products = await shopify.listProducts();
    products.forEach(item => console.log(stringify(item)));
}

async function pull(options, command) {
    const shopify = getShopify();

    const filter = {
        createdAt: options.filterCreated ?? command.parent.opts().filterCreated
    }
    const dryrun = options.dryrun ?? command.parent.opts().dryrun;
    const force = options.force ?? command.parent.opts().force;

    await shopify.pullProducts(program.outputDir, force, dryrun, filter);
}

program
    .version('1.0');

program
    .option('--debug', 'enable debug', false)
    .option('--verbose', 'enable verbose', false)
    .option('--outputDir <dir>', 'location to save the store files', "./")

program
    .command('list')
    .action(list);

program
    .command('pull')
    .description('pull all remote shopify changes locally (defaults to the currently active theme)')
    .option('--force', 'force download all files', false)
    .option('-n, --dry-run', "dont't save files" , false)
    .option('--filter-created <timestamp>', "Only pull files present at given timestamp")
    .action(pull);

if (process.argv.indexOf("--debug") === -1) console.debug = function () {};
if (process.argv.indexOf("--verbose") === -1 && process.argv.indexOf("--debug") === -1) console.info = function () {};

program.parse(process.argv); // end with parse to parse through the input
// if (process.argv.length <= 2) program.help();
