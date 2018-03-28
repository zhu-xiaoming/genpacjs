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

function strip(string, trimStr) {
    if (typeof trimStr === 'undefined') {
        return string.trim();
    }
    let str = trimStr.replace(/]/g, '\\]');
    str = str.replace(/\\/g, '\\\\');
    const s = `^[${str}]+|[${str}]+$`;
    return string.replace(new RegExp(s, 'g'), '');
}


module.exports = {
    rmdirSyncR,
    abspath,
    strip,
};
