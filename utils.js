const fs = require('fs');
const path = require('path');

// 递归清空文件夹
const rmdirSyncR = function(dirPath, removeSelf) {
    if (removeSelf === undefined) {
        removeSelf = true;
    }
    try { var files = fs.readdirSync(dirPath); }
    catch(e) { console.log(e); return false; }
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
};

module.exports = {
    rmdirSyncR
}
