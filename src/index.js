const fs = require('fs');
const nodeUtil = require('util');

const _ = require('lodash');
const ConfigParser = require('configparser');
const request = require('request-promise');

const packageInfo = require('../package.json');
const utils = require('./utils');

const VERSION = packageInfo.version;
const DEFAULT_GFWLIST_URL = 'https://raw.githubusercontent.com/gfwlist/gfwlist/master/gfwlist.txt';

const SOCKS4 = 'socks4';
const SOCKS5 = 'socks5';
const HTTP = 'http';
const PROXY_TYPES = {
    SOCKS4,
    SOCKS5,
    HTTP,
    PROXY: HTTP,
    SOCKS: SOCKS4,
};

const _ret = {};
let _cfg;

function logError(...args) {
    const lastArg = args[args.length - 1];
    const exit = _.get(lastArg, 'exit');
    if (typeof exit === 'undefined') {
        console.error(...args);
    } else {
        console.error(...args.slice(0, -1));
        if (exit === true) {
            process.exit(1);
        }
    }
}

function parseConfig(args) {
    let cfg = {};
    const result = {};
    function update(name, key, defaultValue) {
        const v = _.get(args, name);
        if (typeof v !== 'undefined') {
            return v;
        }
        try {
            return utils.strip(_.get(cfg, key, defaultValue), ' \'\t"');
        } catch (error) {
            return defaultValue;
        }
    }

    result.configFrom = utils.abspath(args.configFrom);
    if (result.configFrom) {
        try {
            const cfgParser = new ConfigParser();
            cfgParser.read(result.configFrom);
            cfg = cfgParser.items('config');
        } catch (error) {
            logError('read config file fail.');
        }
    }
    result.proxy = update('proxy', 'proxy');
    result.output = update('output', 'output');
    result.gfwlistURL = update('gfwlistURL', 'gfwlist-url', DEFAULT_GFWLIST_URL);
    result.gfwlistProxy = update('gfwlistProxy', 'gfwlist-proxy');
    result.gfwlistLocal = update('gfwlistLocal', 'gfwlist-local');
    result.userRuleFrom = update('userRuleFrom', 'user-rule-from');
    result.disableOverwrite = args.disableOverwrite;
    result.userRule = args.userRule;
    if (!Array.isArray(result.userRule)) {
        result.userRule = [result.userRule];
    }
    result.userRuleFrom = args.userRuleFrom;
    if (!Array.isArray(result.userRuleFrom)) {
        result.userRuleFrom = [result.userRuleFrom];
    }

    return result;
}

function prepare(args) {
    _cfg = parseConfig(args);
    _cfg.output = utils.abspath(_cfg.output);
    _cfg.gfwlistLocal = utils.abspath(_cfg.gfwlistLocal);

    _ret.version = VERSION;
    _ret.generated = '';
    _ret.modified = '';
    _ret.gfwlistFrom = '';
    _ret.proxy = _cfg.proxy || 'DIRECT';
    _ret.rules = '';
}

function buildOpener() {
    let proxy;
    // 设置代理
    if (_cfg.gfwlistProxy) {
        const [input, proxyType, proxyUser, proxyPwd, proxyHost, proxyPort] = _cfg.gfwlistProxy.match(/(PROXY|SOCKS|SOCKS4|SOCKS5) (?:(.+):(.+)@)?(.+):(\d+)/i);
        proxy = `${PROXY_TYPES[proxyType.toUpperCase()]}://`;
        if (proxyUser || proxyPwd) {
            proxy = `${proxy}${proxyUser}:${proxyPwd}@`;
        }
        proxy = `${proxy}${proxyHost}:${proxyPort}`;
    }
    return request({
        method: 'get',
        uri: _cfg.gfwlistURL,
        proxy,
    });
}

async function fetchGFWList() {
    let content;
    try {
        content = await buildOpener();
        _ret.gfwlistFrom = nodeUtil.format('online[%s]', _cfg.gfwlistURL);
        if (_cfg.gfwlistLocal && !_cfg.disableOverwrite) {
            fs.writeFile(_cfg.gfwlistLocal, content, (err) => {});
        }
    } catch (error) {
        try {
            content = fs.readFileSync(_cfg.gfwlistLocal, {
                encoding: 'utf8',
            });
            _ret.gfwlistFrom = nodeUtil.format('local[%s]', _cfg.gfwlistLocal);
        } catch (err) {}
    }
    if (!content) {
        logError('fetch gfwlist fail.', { exit: true });
    }
    try {
        content = `! ${Buffer.from(content, 'base64').toString()}`;
        content = content.split(/\r?\n/);
        const lastModifiedLine = content.find(e => e.startsWith('!') && e.includes('Last Modified'));
        if (lastModifiedLine) {
            _ret.modified = utils.strip(lastModifiedLine.split(':').slice(1).join(':'));
        }
    } catch (error) {}

    return content;
}

function fetchUserRules() {
    const rules = _cfg.userRule;
    let ruleString = '';
    _cfg.userRuleFrom.forEach((f) => {
        if (!f) {
            return;
        }
        try {
            ruleString = `${ruleString}\n${fs.readFileSync(utils.abspath(f))}`;
        } catch (error) {
            logError('read user rule file fail. ', f);
        }
    });
    return rules.concat(ruleString.split(/\r?\n/));
}

function parseRules(rules) {
    function wildcardToRegExp(pattern) {
        let p = pattern.replace(/([\\+|{}[\]()^$.#])/g, String.raw`\$1`);
        // p = p.replace(/\*+/g, '*')
        p = p.replace(/\*/g, String.raw`.*`);
        p = p.replace(/\？/g, String.raw`.`);
        return p;
    }

    const directWildcard = [];
    const directRegexp = [];
    const proxyWildcard = [];
    const proxyRegexp = [];

    rules.forEach((l) => {
        let line = utils.strip(l);

        // comment
        if (!line || line.startsWith('!')) {
            return;
        }

        let isDirect = false;
        let isRegexp = true;
        // const originLine = line;
        // 例外
        if (line.startsWith('@@')) {
            line = line.slice(2);
            isDirect = true;
        }

        // 正则表达式语法
        if (line.startsWith('/') && line.endsWith('/')) {
            line = line.slice(1, -1);
        } else if (line.indexOf('^') !== -1) {
            line = wildcardToRegExp(line);
            line = line.replace(/\\\^/g, String.raw`(?:[^\w\-.%\u0080-\uFFFF]|$)`);
        } else if (line.startsWith('||')) {
            line = wildcardToRegExp(line.slice(2));
            // 由于后面输出时使用 JSON.stringify 会自动对其转义，因此这里可不使用对\转义
            line = String.raw`^[\w\-]+:\/+(?!\/)(?:[^\/]+\.)?` + line;
        } else if (line.startsWith('|') || line.endsWith('|')) {
            line = wildcardToRegExp(line);
            line = line.replace(/^\\\|/, '^');
            line = line.replace(/\\\|$/g, '$');
        } else {
            isRegexp = false;
        }

        if (!isRegexp) {
            line = `*${utils.strip(line, '*')}*`;
        }

        if (isDirect) {
            if (isRegexp) {
                directRegexp.push(line);
            } else {
                directWildcard.push(line);
            }
        } else if (isRegexp) {
            proxyRegexp.push(line);
        } else {
            proxyWildcard.push(line);
        }
    });

    return [directRegexp, directWildcard, proxyRegexp, proxyWildcard];
}

function generate(gfwlistRules, userRules) {
    const rules = [parseRules(userRules), parseRules(gfwlistRules)];
    _ret.rules = JSON.stringify(rules, null, 4);
    _ret.generated = new Date().toString();
}

function outputPAC() {
    let content = fs.readFileSync('src/pac-tpl.js', {
        encoding: 'utf8',
    });
    content = content.replace('__VERSION__', _ret.version);
    content = content.replace('__GENERATED__', _ret.generated);
    content = content.replace('__MODIFIED__', _ret.modified);
    content = content.replace('__GFWLIST_FROM__', _ret.gfwlistFrom);
    content = content.replace('__PROXY__', _ret.proxy);
    content = content.replace('__RULES__', _ret.rules);
    if (!_cfg.output) {
        console.info(content);
        return;
    }
    fs.writeFile(_cfg.output, content, (err) => {});
}

async function main({
    proxy,
    output,
    gfwlistURL,
    gfwlistProxy,
    gfwlistLocal,
    disableOverwrite = false,
    userRule = [],
    userRuleFrom = [],
    configFrom,
}) {
    prepare({
        proxy,
        output,
        gfwlistURL,
        gfwlistProxy,
        gfwlistLocal,
        disableOverwrite,
        userRule,
        userRuleFrom,
        configFrom,
    });

    const gfwlist = await fetchGFWList();
    const userRules = fetchUserRules();

    generate(gfwlist, userRules);

    outputPAC();
}


