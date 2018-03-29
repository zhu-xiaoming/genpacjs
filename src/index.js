const fs = require('fs');

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

class GenPAC {
    constructor({
        proxy = '',
        output = '',
        gfwlistURL = DEFAULT_GFWLIST_URL,
        gfwlistProxy = '',
        gfwlistLocal = '',
        disableOverwrite = false,
        userRule = [],
        userRuleFrom = [],
        configFrom = '',
    } = {}) {
        this.configFrom = utils.abspath(configFrom);
        this.disableOverwrite = disableOverwrite;

        const cfg = GenPAC.readConfig(this.configFrom);
        this.proxy = proxy || cfg.proxy;
        this.gfwlistURL = gfwlistURL || cfg.gfwlistURL;
        this.gfwlistProxy = gfwlistProxy || cfg.gfwlistProxy;
        this.output = utils.abspath(output || cfg.output);
        this.gfwlistLocal = utils.abspath(gfwlistLocal || cfg.gfwlistLocal);
        this.userRule = userRule;
        if (!Array.isArray(this.userRule)) {
            this.userRule = [this.userRule];
        }
        this.userRuleFrom = _.isEmpty(userRuleFrom) ? userRuleFrom : cfg.userRuleFrom;
        if (!Array.isArray(this.userRuleFrom)) {
            this.userRuleFrom = [this.userRuleFrom];
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
            proxy: getv('proxy', null),
            output: getv('output', null),
            gfwlistURL: getv('gfwlist-url', DEFAULT_GFWLIST_URL),
            gfwlistProxy: getv('gfwlist-proxy', null),
            gfwlistLocal: getv('gfwlist-local', null),
            userRuleFrom: getv('user-rule-from', null),
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
            if (this.gfwlistLocal && !this.disableOverwrite) {
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
            content = content.split(/\r\n|[\n\r\u0085\u2028\u2029]/g);
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
        return rules.concat(ruleString.split(/\r\n|[\n\r\u0085\u2028\u2029]/g));
    }

    startParse(gfwlistRules, userRules) {
        const rules = [GenPAC.parseRules(userRules), GenPAC.parseRules(gfwlistRules)];
        this._ret.rules = JSON.stringify(rules, null, 4);
        this._ret.generated = new Date().toString();
    }

    outputPAC() {
        let content = fs.readFileSync(utils.resolveApp('src/pac-tpl.js'), {
            encoding: 'utf8',
        });
        content = content.replace('__VERSION__', this._ret.version);
        content = content.replace('__GENERATED__', this._ret.generated);
        content = content.replace('__MODIFIED__', this._ret.modified);
        content = content.replace('__GFWLIST_FROM__', this._ret.gfwlistFrom);
        content = content.replace('__PROXY__', this._ret.proxy);
        content = content.replace('__RULES__', this._ret.rules);
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
