const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readdir } = require('fs').promises;
const { stringify } = require('./stringify');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
Promise.delay = sleep;

async function md5File(filename){
    return new Promise(resolve => {
        const hash = crypto.createHash('md5');
        fs.createReadStream(filename)
            .on('data', data => hash.update(data))
            .on('end', () => resolve(hash.digest('hex')));
    });
}

async function* getFiles(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const res = path.resolve(dir, entry.name);
        if (entry.isDirectory()) {
            yield* getFiles(res);
        } else {
            yield res;
        }
    }
}

function cleanObject(obj, keys=["id"]) {
    for (const k of keys) {
        delete obj[k];
    }
    return obj;
}

function isSame(a, b, ignoreProperties=[]) {
    const left = cleanObject(Object.assign({}, a), ignoreProperties);
    const right = cleanObject(Object.assign({}, b), ignoreProperties);
    return stringify(left) === stringify(right);
}

module.exports = {
    cleanObject,
    isSame,
    getFiles,
    md5File,
    sleep
};
