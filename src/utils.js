const os = require('os');
const fs = require('fs');
const path = require('path');

// 递归清空文件夹
function rmdirSyncR(dirPath, removeSelf) {
    if (removeSelf === undefined) {
        removeSelf = true;
    }
    try {
        var files = fs.readdirSync(dirPath);
    } catch (e) {
        console.log(e);
        return false;
    }
    try {
        if (files.length > 0) {
            for (let i = 0; i < files.length; i++) {
                const filePath = path.join(dirPath, '/', files[i]);
                if (fs.statSync(filePath).isFile()) {
                    fs.unlinkSync(filePath);
                } else {
                    rmdirSyncR(filePath);
                }
            }
        }
        if (removeSelf) {
            fs.rmdirSync(dirPath);
            return true;
        }
    } catch (error) {
        console.log(error);
        return false;
    }

    return true;
}

function abspath(relativePath) {
    if (!relativePath) {
        return relativePath;
    }
    if (relativePath.startsWith('~')) {
        return path.join(os.homedir(), relativePath.slice(1));
    }
    return path.resolve(relativePath);
}

function resolveApp(relativePath) {
    const appRoot = path.resolve(__dirname, '../');
    return path.resolve(appRoot, relativePath);
}

function pkgdata(dataName) {
    return resolveApp(`src/res/${dataName}`);
}

function convBool(value) {
    if (typeof value === 'string') {
        return value.toLowerCase() === 'true';
    }
    return Boolean(value);
}

function listV(value) {
    if (Array.isArray(value)) {
        return value;
    }
    return [value];
}

function replace(content, replaces) {
    let result = content;
    Object.keys(replaces).forEach((k) => {
        result = result.replace(k, replaces[k]);
    });
    return result;
}

function splitLines(string) {
    // RL1.6 Line Boundaries (for unicode)
    // ... it shall recognize not only CRLF, LF, CR,
    // but also NEL, PS and LS.
    return string.split(/\r\n|[\n\r\u0085\u2028\u2029]/g);
}

function checkUndefined(value, defaultValue) {
    return typeof value !== 'undefined' ? value : defaultValue;
}

// https://github.com/getify/JSON.minify/blob/0827b7fd0659d0f10135f4ade0307a625a45a82d/minify.json.js
function jsonMinify(json) {
    let tokenizer = /"|(\/\*)|(\*\/)|(\/\/)|\n|\r/g,
        in_string = false,
        in_multiline_comment = false,
        in_singleline_comment = false,
        tmp,
        tmp2,
        new_str = [],
        ns = 0,
        from = 0,
        lc,
        rc;

    tokenizer.lastIndex = 0;

    while ((tmp = tokenizer.exec(json))) {
        lc = RegExp.leftContext;
        rc = RegExp.rightContext;
        if (!in_multiline_comment && !in_singleline_comment) {
            tmp2 = lc.substring(from);
            if (!in_string) {
                tmp2 = tmp2.replace(/(\n|\r|\s)*/g, '');
            }
            new_str[ns++] = tmp2;
        }
        from = tokenizer.lastIndex;

        if (tmp[0] == '"' && !in_multiline_comment && !in_singleline_comment) {
            tmp2 = lc.match(/(\\)*$/);
            if (!in_string || !tmp2 || tmp2[0].length % 2 == 0) {
                // start of string with ", or unescaped " character found to end string
                in_string = !in_string;
            }
            from--; // include " character in next catch
            rc = json.substring(from);
        } else if (
            tmp[0] == '/*' &&
            !in_string &&
            !in_multiline_comment &&
            !in_singleline_comment
        ) {
            in_multiline_comment = true;
        } else if (tmp[0] == '*/' && !in_string && in_multiline_comment && !in_singleline_comment) {
            in_multiline_comment = false;
        } else if (
            tmp[0] == '//' &&
            !in_string &&
            !in_multiline_comment &&
            !in_singleline_comment
        ) {
            in_singleline_comment = true;
        } else if (
            (tmp[0] == '\n' || tmp[0] == '\r') &&
            !in_string &&
            !in_multiline_comment &&
            in_singleline_comment
        ) {
            in_singleline_comment = false;
        } else if (!in_multiline_comment && !in_singleline_comment && !/\n|\r|\s/.test(tmp[0])) {
            new_str[ns++] = tmp[0];
        }
    }
    new_str[ns++] = rc;
    return new_str.join('');
}

module.exports = {
    rmdirSyncR,
    abspath,
    resolveApp,
    pkgdata,
    jsonMinify,
    convBool,
    listV,
    splitLines,
    replace,
    checkUndefined,
};
