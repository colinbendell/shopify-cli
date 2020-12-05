function forceKeyPrioritySort(keys = ['name', 'value', 'errors']) {
    let objectKeyOrder = new Map();
    for (let i = 0; i < keys.length; i++)
        objectKeyOrder.set(keys[i], `000${i}`.slice(-3));
    return (a, b) => {
        if (objectKeyOrder.size <= 0) return a.localeCompare(b);
        return `${objectKeyOrder.get(a)}${a}`.localeCompare(`${objectKeyOrder.get(b)}${b}`);
    };
}

function defaultSortObjectKey(a,b) {
    return a.localeCompare(b)
}

function stringify (obj, options = {margins: false, indent: 2, maxLength: 80, wrapSimpleArray: true, sortObjectKey: (a,b) => a.localeCompare(b)}) {
    options = options || {};
    let indent = JSON.stringify([1], null, options.indent || 2).slice(2, -3);
    let addMargin = options.margins || false;
    let maxLength = (indent === '' ? Infinity : options.maxLength || 80);
    let wrapSimpleArray = options.wrapSimpleArray || false;
    let sortObjectKeyFunction = !!options.sortObjectKey && typeof options.sortObjectKey === 'function' ? options.sortObjectKey : defaultSortObjectKey;
    let sortObjectKey = !!options.sortObjectKey;

    return (function _stringify (obj, currentIndent, reserved) {
        if (obj && typeof obj.toJSON === 'function') {
            obj = obj.toJSON();
        }

        let string = JSON.stringify(obj);

        if (string === undefined) {
            return string
        }

        let length = maxLength - currentIndent.length - reserved;

        if (!sortObjectKey && string.length <= length) {
            let prettified = prettyMargins(string, addMargin);
            if (prettified.length <= length) {
                return prettified
            }
        }

        if (typeof obj === 'object' && obj !== null) {
            let nextIndent = currentIndent + indent;
            let items = [];
            let delimiters;
            let comma = function (array, index) {
                return (index === array.length - 1 ? 0 : 1)
            };

            if (Array.isArray(obj)) {
                let isSimpleArray = true;
                for (let index = 0; index < obj.length; index++) {
                    items.push(
                        _stringify(obj[index], nextIndent, comma(obj, index)) || 'null'
                    );
                    isSimpleArray &= (typeof obj[index] === "string" || typeof obj[index] === "number" || typeof obj[index] === "boolean");
                }

                if (wrapSimpleArray && isSimpleArray) {
                    let newItems = [];
                    items.forEach(v => {
                        if (newItems.length > 0 && nextIndent.length + newItems[newItems.length - 1].length + v.length < maxLength) {
                            newItems.push(newItems.pop() + ", " + v);
                        }
                        else {
                            newItems.push(v);
                        }
                    });
                    items = newItems;
                }
                delimiters = '[]'
            } else {
                let isSimpleObject = true;
                Object.keys(obj)
                    .sort(sortObjectKeyFunction)
                    .forEach(function (key, index, array) {

                        let keyPart = JSON.stringify(key) + ': ';
                        let value = _stringify(obj[key], nextIndent,
                            keyPart.length + comma(array, index));
                        if (value !== undefined) {
                            items.push(keyPart + value);
                            isSimpleObject &= (typeof obj[key] === "string" || typeof obj[key] === "number" || typeof obj[key] === "boolean");
                        }
                    });
                if (wrapSimpleArray && isSimpleObject) {
                    let newItems = [];
                    items.forEach(v => {
                        if (newItems.length > 0 && nextIndent.length + newItems[newItems.length - 1].length + v.length < maxLength)
                            newItems.push(newItems.pop() + ", " + v);
                        else
                            newItems.push(v);
                    });
                    items = newItems;
                }
                delimiters = '{}'
            }

            if (items.join(', ').length + currentIndent.length + 2 < maxLength) {
                return [
                    delimiters[0],
                    items.join(', '),
                    delimiters[1]
                ].join('')
            }
            else if (items.length > 0) {
                return [
                    delimiters[0],
                    indent + items.join(',\n' + nextIndent),
                    delimiters[1]
                ].join('\n' + currentIndent)
            }
        }

        return string
    }(obj, '', 0))
}

// Note: This regex matches even invalid JSON strings, but since we’re
// working on the output of `JSON.stringify` we know that only valid strings
// are present (unless the user supplied a weird `options.indent` but in
// that case we don’t care since the output would be invalid anyway).
const stringOrChar = /("(?:[^\\"]|\\.)*")|[:,\][}{]/g;

function prettyMargins (string, addMargin) {
    let m = addMargin ? ' ' : '';
    let tokens = {
        '{': '{' + m,
        '[': '[' + m,
        '}': m + '}',
        ']': m + ']',
        ',': ', ',
        ':': ': '
    };
    return string.replace(stringOrChar, function (match, string) {
        return string ? match : tokens[match]
    })
}

module.exports = {
    stringify: stringify,
    defaultSortObjectKey: defaultSortObjectKey,
    forceKeyPrioritySort: forceKeyPrioritySort
};
