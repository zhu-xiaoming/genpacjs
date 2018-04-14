const fs = require('fs');

const { get, trim, camelCase } = require('lodash');
const ConfigParser = require('configparser');
const request = require('request');

const packageInfo = require('../package.json');
const utils = require('./utils');

const VERSION = packageInfo.version;
const DEFAULT_URL = 'https://raw.githubusercontent.com/gfwlist/gfwlist/master/gfwlist.txt';

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

const DEFAULT_CONFIG = {
    proxy: '',
    output: '',
    gfwlistUrl: DEFAULT_URL,
    gfwlistProxy: '',
    gfwlistLocal: '',
    updateGfwlistLocal: true,
    userRule: [],
    userRuleFrom: [],
    configFrom: '',
    compress: false,
    base64: false,
};

class GenPAC {
    constructor({
        proxy,
        output,
        gfwlistUrl,
        gfwlistProxy,
        gfwlistLocal,
        updateGfwlistLocal,
        userRule,
        userRuleFrom,
        configFrom,
        compress,
        base64,
    } = DEFAULT_CONFIG) {
        this.configFrom = configFrom;

        const cfg = GenPAC.readConfig(this.configFrom);
        this.proxy = proxy || cfg.proxy;
        this.gfwlistUrl = gfwlistUrl || cfg.gfwlistUrl;
        this.gfwlistProxy = gfwlistProxy || cfg.gfwlistProxy;

        this.updateGfwlistLocal = utils.convBool(
            utils.checkUndefined(updateGfwlistLocal, cfg.updateGfwlistLocal),
        );
        this.compress = utils.convBool(utils.checkUndefined(compress, cfg.compress));
        this.base64 = utils.convBool(utils.checkUndefined(base64, cfg.base64));

        this.output = output || cfg.output;
        this.gfwlistLocal = gfwlistLocal || cfg.gfwlistLocal;

        this.userRule = userRule;
        if (!Array.isArray(this.userRule)) {
            this.userRule = [this.userRule];
        }
        this.userRule = this.userRule.map(e => trim(e, ' \'\t"'));

        this.userRuleFrom = userRuleFrom || cfg.userRuleFrom;
        if (!Array.isArray(this.userRuleFrom)) {
            this.userRuleFrom = [this.userRuleFrom];
        }

        if (this.base64) {
            this.compress = true;
            GenPAC.logError(
                'WARNING: some browser DO NOT support pac file which was encoded by base64.',
            );
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
        const exit = get(lastArg, 'exit');
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
        let cfg = DEFAULT_CONFIG;
        function getv(k) {
            const d = DEFAULT_CONFIG[camelCase(k)];
            try {
                return trim(get(cfg, k, d), ' \'\t"');
            } catch (error) {
                return d;
            }
        }
        if (!configFrom) {
            return cfg;
        }
        try {
            const cfgParser = new ConfigParser();
            cfgParser.read(utils.abspath(configFrom));
            cfg = cfgParser.items('config');
        } catch (error) {
            GenPAC.logError('read config file fail.', { exit: true });
        }
        return {
            proxy: getv('proxy'),
            output: getv('output'),
            gfwlistUrl: getv('gfwlist-url'),
            gfwlistProxy: getv('gfwlist-proxy'),
            gfwlistLocal: getv('gfwlist-local'),
            userRuleFrom: getv('user-rule-from'),
            updateGfwlistLocal: getv('update-gfwlist-local'),
            compress: getv('compress'),
            base64: getv('base64'),
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
            let line = trim(l);

            // comment
            if (!line || line.startsWith('!')) {
                return;
            }

            let isDirect = false;
            let isRegexp = true;
            // exception rules
            if (line.startsWith('@@')) {
                line = line.slice(2);
                isDirect = true;
            }

            // regular expressions
            if (line.startsWith('/') && line.endsWith('/')) {
                line = line.slice(1, -1);
            } else if (line.indexOf('^') !== -1) {
                line = wildcardToRegExp(line);
                line = line.replace(/\\\^/g, String.raw`(?:[^\w\-.%\u0080-\uFFFF]|$)`);
            } else if (line.startsWith('||')) {
                line = wildcardToRegExp(line.slice(2));
                // When using the constructor function, the normal string
                // escape rules (preceding special characters with \ when
                // included in a string) are necessary.
                // For example, the following are equivalent:
                // re = new RegExp('\\w+')
                // re = /\w+/
                // via: http://aptana.com/reference/api/RegExp.html
                // line = r'^[\\w\\-]+:\\/+(?!\\/)(?:[^\\/]+\\.)?' + line
                // JSON.stringify will escape `\`
                line = String.raw`^[\w\-]+:\/+(?!\/)(?:[^\/]+\.)?` + line;
            } else if (line.startsWith('|') || line.endsWith('|')) {
                line = wildcardToRegExp(line);
                line = line.replace(/^\\\|/, '^');
                line = line.replace(/\\\|$/g, '$');
            } else {
                isRegexp = false;
            }

            if (!isRegexp) {
                line = `*${trim(line, '*')}*`;
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
            // format: PROXY|SOCKS|SOCKS4|SOCKS5 [USR:PWD]@HOST:PORT
            const [
                input,
                proxyType,
                proxyUser,
                proxyPwd,
                proxyHost,
                proxyPort,
            ] = this.gfwlistProxy.match(/(PROXY|SOCKS|SOCKS4|SOCKS5) (?:(.+):(.+)@)?(.+):(\d+)/i);
            proxy = `${PROXY_TYPES[proxyType.toUpperCase()]}://`;
            if (proxyUser || proxyPwd) {
                proxy = `${proxy}${proxyUser}:${proxyPwd}@`;
            }
            proxy = `${proxy}${proxyHost}:${proxyPort}`;
        }
        return new Promise((resolve, reject) => {
            request({
                method: 'get',
                uri: this.gfwlistUrl,
                proxy,
            }, (err, response, body) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(body);
                }
            });
        });
    }

    async fetchGfwlist() {
        let content = '';
        try {
            content = await this.buildOpener();
            this._ret.gfwlistFrom = `online[${this.gfwlistUrl}]`;
            if (this.gfwlistLocal && this.updateGfwlistLocal) {
                fs.writeFile(utils.abspath(this.gfwlistLocal), content, (err) => {});
            }
        } catch (error) {
            try {
                content = fs.readFileSync(utils.abspath(this.gfwlistLocal), {
                    encoding: 'utf8',
                });
                this._ret.gfwlistFrom = `local[${this.gfwlistLocal}]`;
            } catch (err) {}
        }
        if (!content) {
            if (this.gfwlistUrl !== '-' || this.gfwlistLocal) {
                GenPAC.logError('fetch gfwlist fail.', { exit: true });
            } else {
                this._ret.gfwlistFrom = 'unused';
            }
        }
        try {
            content = `! ${Buffer.from(content, 'base64').toString('utf8')}`;
            content = utils.splitLines(content);
            const lastModifiedLine = content.find(
                e => e.startsWith('!') && e.includes('Last Modified'),
            );
            if (lastModifiedLine) {
                this._ret.modified = trim(
                    lastModifiedLine
                        .split(':')
                        .slice(1)
                        .join(':'),
                );
            }
        } catch (error) {}

        if (!this._ret.modified) {
            this._ret.modified = '-';
        }

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
                ruleString = `${ruleString}\n${fs.readFileSync(utils.abspath(f), {
                    encoding: 'utf8',
                })}`;
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
        this._ret.generated = new Date();
        this._ret.generated = this._ret.generated.toLocaleString();
    }

    outputPac() {
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

        if (this.output && this.output !== '-') {
            fs.writeFile(utils.abspath(this.output), content, (err) => {});
        } else {
            console.info(content);
        }
    }

    async generate() {
        const gfwlistRules = await this.fetchGfwlist();
        const userRules = this.fetchUserRules();
        this.startParse(gfwlistRules, userRules);
        this.outputPac();
    }
}

module.exports = GenPAC;
