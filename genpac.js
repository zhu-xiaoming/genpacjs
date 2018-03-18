const os = require('os');
const fs = require('fs');
const path = require('path');
const nodeUtil = require('util');

const _ = require('lodash');
const request = require('request-promise');
const ConfigParser = require('configparser');

const socks = require('./socks');
const utils = require('./utils');

const VERSION = '0.2.1';

const defaultConfig = {
  gfwUrl: 'http://autoproxy-gfwlist.googlecode.com/svn/trunk/gfwlist.txt',
  gfwProxyType: 2,
  gfwProxyHost: '127.0.0.1',
  gfwProxyPort: 9527,
  gfwProxyUsr: undefined,
  gfwProxyPwd: undefined,
  pacProxyType: 2,
  pacProxyHost: '127.0.0.1',
  pacProxyPort: 9527,
  pacFilename: 'AutoProxy.pac',
  DebugMode: false,
  JSVersion: true,
};

let gfwlistContent = '';
let gfwlistModified = '';
let config = {};

function configGet(key) {
  const value = _.get(config, key);
  if (typeof value === 'undefined' || value === '') {
    return defaultConfig[key];
  }
  return value;
}

function getBoolean(value) {
  if (value === 'true' || value === 'false') {
    const obj = {
      true: true,
      false: false,
    };
    return obj[value];
  }
  return false;
}

function parseConfig() {
  const cf = new ConfigParser();
  cf.read('config.txt');

  try {
    config = {
      gfwUrl: cf.get('config', 'gfwUrl'),
      gfwProxyType: cf.getInt('config', 'gfwProxyType'),
      gfwProxyHost: cf.get('config', 'gfwProxyHost'),
      gfwProxyPort: cf.getInt('config', 'gfwProxyPort'),
      gfwProxyUsr: cf.get('config', 'gfwProxyUsr'),
      gfwProxyPwd: cf.get('config', 'gfwProxyPwd'),
      pacProxyType: cf.getInt('config', 'pacProxyType'),
      pacProxyHost: cf.get('config', 'pacProxyHost'),
      pacProxyPort: cf.getInt('config', 'pacProxyPort'),
      pacFilename: cf.get('config', 'pacFilename'),
      DebugMode: getBoolean(cf.get('config', 'DebugMode')),
      JSVersion: getBoolean(cf.get('config', 'JSVersion')),
    };
  } catch (error) {
    console.log('解析配置文件出错: ', error);
  }
}

function generateProxyVar() {
  const host = `${configGet('pacProxyHost')}:${configGet('pacProxyPort')}`;
  if (configGet('pacProxyType') === 1) {
    return `SOCKS ${host}`;
  } else if (configGet('pacProxyType') === 3) {
    return `PROXY ${host}`;
  }
  return `SOCKS5 ${host}; SOCKS ${host}`;
}

function printConfigInfo() {
  console.log('配置信息: ');
  console.log(
    `GFWList Proxy: Type: ${configGet('gfwProxyType')}, Host: ${configGet(
      'gfwProxyHost',
    )}, Port: ${configGet('gfwProxyPort')} , Usr: ${configGet(
      'gfwProxyUsr',
    )}, Pwd: ${configGet('gfwProxyPwd')}`,
  );
  console.log(`PAC Proxy String: ${generateProxyVar()}`);
}

async function fetchGFWList() {
  if (configGet('DebugMode')) {
    request.debug = true;
  }
  try {
    if (configGet('gfwUrl')) {
      const gfwProxyType = configGet('gfwProxyType');
      if (
        gfwProxyType === socks.PROXY_TYPE_SOCKS4 ||
        gfwProxyType === socks.PROXY_TYPE_SOCKS5 ||
        gfwProxyType === socks.PROXY_TYPE_HTTP
      ) {
        // socks.setdefaultproxy(
        //   gfwProxyType, config['gfwProxyHost'], config['gfwProxyPort'], True, config['gfwProxyUsr'], config['gfwProxyPwd'])
        // socket.socket = socks.socksocket
      }

      const res = await request.get(configGet('gfwUrl'));
      gfwlistModified = res['last-modified'];
      gfwlistContent = res;
    } else if (fs.existsSync('origin_gfwlist.txt')) {
      const res = (await nodeUtil.promisify(fs.readFile)(
        'origin_gfwlist.txt',
      )).toString();
      gfwlistModified = res['last-modified'];
      gfwlistContent = res;
    }
    console.log(`GFWList[Last-Modified: ${gfwlistModified}] 获取成功`);
  } catch (error) {
    console.log('GFWList 获取失败，请检查相关内容是否配置正确。');
    console.log('error info: ', error);
    process.exit(1);
  }
}

function wildcardToRegexp(pattern) {
  pattern = pattern.replace(/([\\+|{}[\]()^$.#])/g, String.raw`\$1`);
  pattern = pattern.replace(/\*/g, String.raw`.*`);
  pattern = pattern.replace(/\？/g, String.raw`.`);
  return pattern;
}

function parseRuleList(ruleString) {
  const directWildcardList = [];
  const directRegexpList = [];
  const proxyWildcardList = [];
  const proxyRegexpList = [];
  const ruleList = ruleString.split(/\r?\n/);

  ruleList.forEach((l) => {
    let line = l;
    // 忽略注释
    if (line.length === 0 || line.startsWith('!') || line.startsWith('[')) {
      // console.log('注释: ', line);
      return;
    }

    let isDirect = false;
    let isRegexp = true;

    const originLine = line;

    // 例外
    if (line.startsWith('@@')) {
      line = line.slice(2);
      isDirect = true;
      // console.log('例外: ', originLine);
    }

    // 正则表达式语法
    if (line.startsWith('/') && line.endsWith('/')) {
      line = line.slice(1, -1);
    } else if (line.indexOf('^') !== -1) {
      line = wildcardToRegexp(line);
      line = line.replace(/\\\^/g, String.raw`(?:[^\w\-.%\u0080-\uFFFF]|$)`);
    } else if (line.startsWith('||')) {
      line = wildcardToRegexp(line.slice(2));
      line = String.raw`^[\\w\\-]+:\\/+(?!\\/)(?:[^\\/]+\\.)?` + line;
    } else if (line.startsWith('|') || line.endsWith('|')) {
      line = wildcardToRegexp(line);
      line = line.replace(/^\\\|/, '^');
      line = line.replace(/\\\|$/g, '$');
    } else {
      isRegexp = false;
    }

    if (!isRegexp) {
      if (!line.startsWith('*')) {
        line = `*${line}`;
      }
      if (!line.endsWith('*')) {
        line += '*';
      }
    }

    if (isDirect) {
      if (isRegexp) {
        directRegexpList.push(line);
      } else {
        directWildcardList.push(line);
      }
    } else if (isRegexp) {
      proxyRegexpList.push(line);
    } else {
      proxyWildcardList.push(line);
    }

    if (configGet('DebugMode')) {
      fs.writeFile(
        'tmp/rule.txt',
        `${originLine}\n\t${line}\n\n`,
        {
          flag: 'a',
        },
        err => err && console.log(err),
      );
    }
  });

  return {
    directRegexpList,
    directWildcardList,
    proxyRegexpList,
    proxyWildcardList,
  };
}

function parseGFWListRules() {
  fs.writeFile(
    'tmp/origin_gfwlist.txt',
    gfwlistContent,
    err => err && console.log(err),
  );
  const gfwlist = Buffer.from(gfwlistContent, 'base64');
  if (configGet('DebugMode')) {
    fs.writeFile('tmp/gfwlist.txt', gfwlist, err => err && console.log(err));
  }
  return parseRuleList(gfwlist.toString());
}

function parseUserRules() {
  return nodeUtil
    .promisify(fs.readFile)('user-rules.txt')
    .then((data) => {
      const {
        directRegexpList: directUserRegexpList,
        directWildcardList: directUserWildcardList,
        proxyRegexpList: proxyUserRegexpList,
        proxyWildcardList: proxyUserWildcardList,
      } = parseRuleList(data.toString());
      return {
        directUserRegexpList,
        directUserWildcardList,
        proxyUserRegexpList,
        proxyUserWildcardList,
      };
    })
    .catch((err) => {
      console.log(err);
      return {
        directUserRegexpList: [],
        directUserWildcardList: [],
        proxyUserRegexpList: [],
        proxyUserWildcardList: [],
      };
    });
}

function convertListToJSArray(lst) {
  let array = lst
    .filter(e => typeof e === 'string' && e.length > 0)
    .join("',\n    '");
  if (array.length > 0) {
    array = `\n    '${array}'\n    `;
  }
  return `[${array}]`;
}

function generatePACRuls(gfwlistRules, userRules) {
  const {
    directRegexpList,
    directWildcardList,
    proxyRegexpList,
    proxyWildcardList,
  } = gfwlistRules;
  const {
    directUserRegexpList,
    directUserWildcardList,
    proxyUserRegexpList,
    proxyUserWildcardList,
  } = userRules;

  const rules = `
// user rules
var directUserRegexpList   = ${convertListToJSArray(directUserRegexpList)};
var directUserWildcardList = ${convertListToJSArray(directUserWildcardList)};
var proxyUserRegexpList    = ${convertListToJSArray(proxyUserRegexpList)};
var proxyUserWildcardList  = ${convertListToJSArray(proxyUserWildcardList)};

// gfwlist rules
var directRegexpList   = ${convertListToJSArray(directRegexpList)};
var directWildcardList = ${convertListToJSArray(directWildcardList)};
var proxyRegexpList    = ${convertListToJSArray(proxyRegexpList)};
var proxyWildcardList  = ${convertListToJSArray(proxyWildcardList)};
`;

  return rules;
}

function createPacFile(gfwlistRules, userRules) {
  const result = {
    ver: VERSION,
    generated: new Date(),
    gfwmodified: gfwlistModified,
    proxy: generateProxyVar(),
    rules: generatePACRuls(gfwlistRules, userRules),
  };
  const pacContent = `/**
 * GenPAC ${result.ver} http://jeeker.net/projects/genpac/
 * Generated: ${result.generated}
 * GFWList Last-Modified: ${result.gfwmodified}
 */

// proxy
var P = "${result.proxy}";
${result.rules}
function FindProxyForURL(url, host) {
    var D = "DIRECT";

    var regExpMatch = function(url, pattern) {
        try { 
            return new RegExp(pattern).test(url); 
        } catch(ex) { 
            return false; 
        }
    };
    
    var i = 0;

    for (i in directUserRegexpList) {
        if(regExpMatch(url, directUserRegexpList[i])) return D;
    }

    for (i in directUserWildcardList) {
        if (shExpMatch(url, directUserWildcardList[i])) return D;
    }

    for (i in proxyUserRegexpList) {
        if(regExpMatch(url, proxyUserRegexpList[i])) return P;
    }

    for (i in proxyUserWildcardList) {
        if(shExpMatch(url, proxyUserWildcardList[i])) return P;
    }

    for (i in directRegexpList) {
        if(regExpMatch(url, directRegexpList[i])) return D;
    }

    for (i in directWildcardList) {
        if (shExpMatch(url, directWildcardList[i])) return D;
    }

    for (i in proxyRegexpList) {
        if(regExpMatch(url, proxyRegexpList[i])) return P;
    }

    for (i in proxyWildcardList) {
        if(shExpMatch(url, proxyWildcardList[i])) return P;
    }

    return D;
  }
`;

  const write = nodeUtil.promisify(fs.writeFile);
  return write(configGet('pacFilename'), pacContent).catch(
    err => err && console.log(err),
  );
}

async function main() {
  // TODO: 更改工作目录为脚本所在目录

  if (!fs.existsSync('tmp') || !fs.statSync('tmp').isDirectory()) {
    fs.mkdirSync('tmp');
  }

  // 清空 tmp 文件夹
  utils.rmdirSyncR('tmp', false);

  // 解析配置
  parseConfig();

  // 打印配置
  printConfigInfo();

  // 获取 gfwlist
  console.log('开始获取 gfwlist: ', configGet('gfwUrl'));
  await fetchGFWList();

  // 解析 gfwlist rule
  console.log('开始解析 GFWList 规则');
  const gfwlistRules = parseGFWListRules();

  // 解析用户规则
  console.log('正在解析用户自定义规则 ...');
  const userRules = await parseUserRules();

  // 创建 pac 文件
  console.log(`正在生成 ${configGet('pacFilename')} ...`);
  await createPacFile(gfwlistRules, userRules);

  console.log('一切就绪');
}

main();
