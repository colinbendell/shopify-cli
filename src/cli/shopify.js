#!/usr/bin/env node

'use strict';

const program = require('commander');

program
    .version('1.0');

program
    .option('--outputDir <dir>', 'location to save the store files', "./")
    .command('store', 'manage the Shopify Online Store', {isDefault: true})
    .command('products', 'Manage products and inventory');

if (process.argv.indexOf("--debug") === -1) console.debug = function() {};
if (process.argv.indexOf("--verbose") === -1 && process.argv.indexOf("--debug") === -1) console.info = function() {};

if (process.argv.length <= 2) program.help();
//if (!['store', 'products'].includes(process.argv[2])) process.argv = [].concat(process.argv.slice(0,2), 'store', process.argv.slice(2));

program
    .parse(process.argv); // end with parse to parse through the input
