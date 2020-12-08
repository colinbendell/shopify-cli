const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readdir } = require('fs').promises;
const { stringify } = require('./stringify');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
Promise.delay = sleep;

function md5(data){
    return crypto.createHash('md5').update(data.toString()).digest('hex');
}

async function md5File(filename){
    if (typeof filename === 'string' && fs.existsSync(filename)) {
        return new Promise(resolve => {
            const hash = crypto.createHash('md5');
            fs.createReadStream(filename)
                .on('data', data => hash.update(data))
                .on('end', () => resolve(hash.digest('hex')));
        });
    }

    return crypto.createHash('md5').update(filename.toString()).digest('hex');
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

function globAsRegex (glob = "") {
    if (!glob || typeof glob !== 'string') return;

    // .() => \.\(\)
    glob = glob.replace(/([/$^+.()=!|])/g, "\\$1");
    // {foo} => (foo)
    // {foo,bar} => (foo|bar)
    for (const match of glob.matchAll(/({[^}]+})/g)) {
        glob = glob.replace(match[0], "(?:" + match[1].replace(/,/g, "|") + ")");
    }
    // foo*bar => foo[^/]*bar
    // *bar => [^/]*bar
    // bar* => foo[^/]*
    // foo**bar => foo.*bar
    // **bar => .*bar
    // foo** => foo.*
    for (const match of glob.matchAll(/([^*]|^)(\*+)([^*]|$)/g)) {
        if (match[2].length > 1) {
            glob = glob.replace(match[0], match[1] + ".*" + match[3]);
        }
        else {
            glob = glob.replace(match[0], match[1] + "[^/]*" + match[3]);
        }
    }
    // , => \,
    glob = glob.replace(/,/g, "\\,");

    // remove the final / since it will be added at the end
    // foobar/ => foobar
    glob = glob.replace(/\/$/g, "");
    // foobar => ^foobar($|/)
    return new RegExp("^" + glob + "(?:$|/)", "i");
}

module.exports = {
    cleanObject,
    isSame,
    getFiles,
    globAsRegex,
    md5,
    md5File,
    sleep
};
