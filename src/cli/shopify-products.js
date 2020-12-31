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

program
    .version('1.0');

program
    .option('--debug', 'enable debug', false)
    .option('--verbose', 'enable verbose', false)
    .option('--outputDir <dir>', 'location to save the store files', "./")

program
    .command('list')
    .action(list);

if (process.argv.indexOf("--debug") === -1) console.debug = function () {};
if (process.argv.indexOf("--verbose") === -1 && process.argv.indexOf("--debug") === -1) console.info = function () {};

program.parse(process.argv); // end with parse to parse through the input
if (process.argv.length <= 2) program.help();
