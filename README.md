# Shopify CLI
Versatile cli tool that interfaces with the various shopify apis. Current consumer is for onlinestore

## Setup
`npm install`

## Authentication
Make sure you have created a private app. You can create a file ~/.shopify or use environment variables.


//TODO: convert to .env
```
[default]
key=c034ddcbcdasdf
password=shppa_7d07719asdfasdf
storefront=b46516dad796fbasdfasdf
host=shoesbycolin.com
```

Alternatively use these environment variables to map to the above values:
* `SHOPIFY_KEY`
* `SHOPIFY_PASSWORD`
* `SHOPIFY_STOREFRONT_ACCESS_TOKEN`
* `SHOPIFY_HOST`

Also useful is `SHOPIFY_RC` to change the file from ~/.shopify and `SHOPIFY_SECTION` to change from `Default` 

## Pull
`bin/shopify-website pull`
