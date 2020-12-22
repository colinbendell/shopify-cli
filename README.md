# Shopify CLI
Versatile cli tool that interfaces with the various shopify apis. Current consumer is for onlinestore

## Setup
`npm install`

## Basic Usages
The cli uses git style commands and include:
* `pull` - capture changes from shopify and store them locally
* `push` - push changes from local to shopify
* `list` - list the themes or files in the store
* `init` - create a new draft in shopfiy //TODO: re-evaluate
* `publish` - support moving a theme branch to main

For example:
```
> bin/shopify store pull
```
```
SAVING: blogs/no-stinkin-outlaws/and-what-the-heck-is-up-with-that-super-cool-padding.html
SAVING: blogs/no-stinkin-outlaws/sustainable-shipping.html
SAVING: scripts.csv
SAVING: redirects.csv
SAVING: menus/404.md
SAVING: menus/footer.md
SAVING: menus/main-menu.md
SAVING: menus/products.md
SAVING: snippets/social-meta.liquid
SAVING: assets/main.css
SAVING: config/settings_data.json
SAVING: locales/en.default.json
SAVING: layout/theme.liquid
SAVING: templates/index.liquid
```


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
