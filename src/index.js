const fs = require('fs');

const _ = require('lodash');
const ConfigParser = require('configparser');
const request = require('request-promise');

const packageInfo = require('../package.json');
const utils = require('./utils');

const VERSION = packageInfo.version;
const DEFAULT_GFWLIST_URL = 'https://raw.githubusercontent.com/gfwlist/gfwlist/master/gfwlist.txt';

const PAC_TPL = 'pac-tpl.js';
const PAC_TPL_MIN = 'pac-tpl.min.js';
const PAC_TPL_BASE64 = 'pac-tpl.base64.js';

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

class GenPAC {
    constructor({
        proxy = '',
        output = '',
        gfwlistURL = DEFAULT_GFWLIST_URL,
        gfwlistProxy = '',
        gfwlistLocal = '',
        updateGFWListLocal,
        userRule = [],
        userRuleFrom = [],
        configFrom = '',
        compress,
        base64,
    } = {}) {
        this.configFrom = utils.abspath(configFrom);
        
        const cfg = GenPAC.readConfig(this.configFrom);
        this.proxy = proxy || cfg.proxy;
        this.gfwlistURL = gfwlistURL || cfg.gfwlistURL;
        this.gfwlistProxy = gfwlistProxy || cfg.gfwlistProxy;

        this.updateGFWListLocal = utils.convBool(typeof updateGFWListLocal !== 'undefined' ? updateGFWListLocal : cfg.updateGFWListLocal);
        this.compress = utils.convBool(typeof compress !== 'undefined' ? compress : cfg.compress);
        this.base64 = utils.convBool(typeof base64 !== 'undefined' ? base64 : cfg.base64);

        this.output = utils.abspath(output || cfg.output);
        this.gfwlistLocal = utils.abspath(gfwlistLocal || cfg.gfwlistLocal);

        this.userRule = userRule;
        if (!Array.isArray(this.userRule)) {
            this.userRule = [this.userRule];
        }
        this.userRuleFrom = !_.isEmpty(userRuleFrom) ? userRuleFrom : cfg.userRuleFrom;
        if (!Array.isArray(this.userRuleFrom)) {
            this.userRuleFrom = [this.userRuleFrom];
        }

        if (this.base64) {
            GenPAC.logError('WARNING: some brower DO NOT support pac file which was encoded by base64.');
        }

        this._ret = {
            version: VERSION,
            proxy: this.proxy || 'DIRECT',
            generated: '',
            modified: '',
            gfwlistFrom: '',
            rules: '',
        };
    }

    static logError(...args) {
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

    static readConfig(configFrom) {
        let cfg = {};
        function getv(k, d) {
            try {
                return utils.strip(_.get(cfg, k, d), ' \'\t"');
            } catch (error) {
                return d;
            }
        }
        if (!configFrom) {
            return cfg;
        }
        try {
            const cfgParser = new ConfigParser();
            cfgParser.read(configFrom);
            cfg = cfgParser.items('config');
        } catch (error) {
            GenPAC.logError('read config file fail.');
        }
        return {
            proxy: getv('proxy', ''),
            output: getv('output', ''),
            gfwlistURL: getv('gfwlist-url', DEFAULT_GFWLIST_URL),
            gfwlistProxy: getv('gfwlist-proxy', ''),
            gfwlistLocal: getv('gfwlist-local', ''),
            userRuleFrom: getv('user-rule-from', []),
            updateGFWListLocal: getv('update-gfwlist-local', true),
            compress: getv('compress', false),
            base64: getv('base64', false),
        };
    }

    static parseRules(rules) {
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

    buildOpener() {
        let proxy;
        // 设置代理
        if (this.gfwlistProxy) {
            const [input, proxyType, proxyUser, proxyPwd, proxyHost, proxyPort] = this.gfwlistProxy.match(/(PROXY|SOCKS|SOCKS4|SOCKS5) (?:(.+):(.+)@)?(.+):(\d+)/i);
            proxy = `${PROXY_TYPES[proxyType.toUpperCase()]}://`;
            if (proxyUser || proxyPwd) {
                proxy = `${proxy}${proxyUser}:${proxyPwd}@`;
            }
            proxy = `${proxy}${proxyHost}:${proxyPort}`;
        }
        return request({
            method: 'get',
            uri: this.gfwlistURL,
            proxy,
        });
    }

    async fetchGFWList() {
        let content;
        try {
            content = await this.buildOpener();
            this._ret.gfwlistFrom = `online[${this.gfwlistURL}]`;
            if (this.gfwlistLocal && this.updateGFWListLocal) {
                fs.writeFile(this.gfwlistLocal, content, (err) => {});
            }
        } catch (error) {
            try {
                content = fs.readFileSync(this.gfwlistLocal, {
                    encoding: 'utf8',
                });
                this._ret.gfwlistFrom = `local[${this.gfwlistLocal}]`;
            } catch (err) {}
        }
        if (!content) {
            GenPAC.logError('fetch gfwlist fail.', { exit: true });
        }
        try {
            content = `! ${Buffer.from(content, 'base64').toString('utf8')}`;
            content = utils.splitLines(content);
            const lastModifiedLine = content.find(e => e.startsWith('!') && e.includes('Last Modified'));
            if (lastModifiedLine) {
                this._ret.modified = utils.strip(lastModifiedLine.split(':').slice(1).join(':'));
            }
        } catch (error) {}

        return content;
    }

    fetchUserRules() {
        const rules = this.userRule;
        let ruleString = '';
        this.userRuleFrom.forEach((f) => {
            if (!f) {
                return;
            }
            try {
                ruleString = `${ruleString}\n${fs.readFileSync(utils.abspath(f), { encoding: 'utf8' })}`;
            } catch (error) {
                GenPAC.logError('read user rule file fail. ', f);
            }
        });
        return rules.concat(utils.splitLines(ruleString));
    }

    startParse(gfwlistRules, userRules) {
        const rules = [GenPAC.parseRules(userRules), GenPAC.parseRules(gfwlistRules)];
        if (this.compress) {
            this._ret.rules = JSON.stringify(rules);
        } else {
            this._ret.rules = JSON.stringify(rules, null, 4);
        }
        this._ret.generated = new Date().toString();
    }

    outputPAC() {
        const pacTpl = utils.pkgdata(this.compress ? PAC_TPL_MIN : PAC_TPL);
        let content = fs.readFileSync(pacTpl, {
            encoding: 'utf8',
        });

        content = utils.replace(content, {
            __VERSION__: this._ret.version,
            __GENERATED__: this._ret.generated,
            __MODIFIED__: this._ret.modified,
            __GFWLIST_FROM__: this._ret.gfwlistFrom,
            __PROXY__: this._ret.proxy,
            __RULES__: this._ret.rules,
        });

        if (this.base64) {
            const b64 = fs.readFileSync(utils.pkgdata(PAC_TPL_BASE64), {
                encoding: 'utf8',
            });
            content = utils.replace(b64, {
                __BASE64__: Buffer.from(content).toString('base64'),
                __VERSION__: this._ret.version,
            });
        }

        if (!this.output) {
            console.info(content);
            return;
        }
        fs.writeFile(this.output, content, (err) => {});
    }

    async generate() {
        const gfwlistRules = await this.fetchGFWList();
        const userRules = this.fetchUserRules();
        this.startParse(gfwlistRules, userRules);
        this.outputPAC();
    }
}

module.exports = GenPAC;
