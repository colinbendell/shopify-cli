#!/usr/bin/env node

'use strict';

const program = require('commander');

program
    .version('1.0');

program
    // .option('--outputDir <dir>', 'location to save the store files', "./")
    .allowExcessArguments(true)
    .allowUnknownOption(true)
    .enablePositionalOptions()
    .command('store', 'manage the Shopify Online Store', {isDefault: true})
    .command('products', 'Manage products and inventory');

program.parseAsync(); // end with parse to parse through the input
