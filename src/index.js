const fs = require('fs');
const url = require('url');

const { get, trim, trimStart, camelCase } = require('lodash');
const ConfigParser = require('configparser');
const psl = require('psl');
const request = require('request');

const packageInfo = require('../package.json');
const utils = require('./utils');

const VERSION = packageInfo.version;
const DEFAULT_URL = 'https://raw.githubusercontent.com/gfwlist/gfwlist/master/gfwlist.txt';

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
    gfwlistDisabled: false,
    updateGfwlistLocal: true,
    userRule: [],
    userRuleFrom: [],
    configFrom: '',
    compress: false,
    precise: false,
};

class GenPAC {
    constructor({
        proxy,
        output,
        gfwlistUrl,
        gfwlistProxy,
        gfwlistLocal,
        gfwlistDisabled,
        updateGfwlistLocal,
        userRule,
        userRuleFrom,
        configFrom,
        compress,
        precise,
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
        this.precise = utils.convBool(utils.checkUndefined(precise, cfg.precise));

        this.output = output || cfg.output;
        this.gfwlistLocal = gfwlistLocal || cfg.gfwlistLocal;
        this.gfwlistDisabled = gfwlistDisabled || cfg.gfwlistDisabled;

        this.userRule = utils.listV(userRule).map(e => trim(e, ' \'\t"'));
        this.userRuleFrom = utils.listV(userRuleFrom || cfg.userRuleFrom);

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
            gfwlistDisabled: getv('gfwlist-disabled'),
            userRuleFrom: getv('user-rule-from'),
            updateGfwlistLocal: getv('update-gfwlist-local'),
            compress: getv('compress'),
            precise: getv('precise'),
        };
    }

    static parseRulesPrecise(rules) {
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

    static getPublicSuffix(host) {
        let domain;
        if (host.search(/^(\d{0,3}\.){3}\d{0,3}$/g) < 0) {
            if (host.startsWith('.')) {
                host = trimStart(host, '.');
            }
            const { sld, tld, error, domain: d } = psl.parse(host);
            if (!error) {
                if (sld) {
                    domain = d;
                } else {
                    domain = tld;
                }
            }
        }
        if (!domain || !domain.includes('.') || domain.endsWith('.')) {
            domain = null;
        }
        return domain;
    }

    static clearAsterisk(rule) {
        let r = rule;
        if (r.includes('*')) {
            r = trim(r, '*');
            r = r.replace('/*.', '/');
            r = r.replace(/\/([a-zA-Z0-9]+)\*\./g, '/');
            r = r.replace(/\*([a-zA-Z0-9_%]+)/g, '');
            r = r.replace(/^([a-zA-Z0-9_%]+)\*/g, '');
        }
        return r;
    }

    static surmiseDomain(rule) {
        let domain = '';

        rule = GenPAC.clearAsterisk(rule);
        rule = trimStart(rule, '.');
        
        if (rule.includes('%2F')) {
            rule = decodeURIComponent(rule);
        }
        
        const t = rule.indexOf('/');
        if (rule.startsWith('http:') || rule.startsWith('https:')) {
            const r = url.parse(rule);
            domain = r.hostname;
        } else if (t > 0 && rule.search(/[()]/g) > 0) {
            domain = rule.slice(0, t);
        } else if (rule.indexOf('*/') > 0) {
            domain = rule.slice(0, t);
        } else if (t > 0) {
            const r = url.parse(`http://${rule}`);
            domain = r.hostname;
        } else if (rule.indexOf('.') > 0) {
            domain = rule;
        }

        return GenPAC.getPublicSuffix(domain);
    }

    static parseRules(rules) {
        let directLst = [];
        let proxyLst = [];
        rules.forEach((l) => {
            let line = l;
            let domain = '';

            if (!line || line.startsWith('!')) {
                return;
            }

            if (line.startsWith('@@')) {
                line = trimStart(line, '@|.');
                domain = GenPAC.surmiseDomain(line);

                if (domain) {
                    directLst.push(domain);
                }
                return;
            } else if (line.indexOf('.*') >= 0 || line.startsWith('/')) {
                line = line.replace(/\\\//g, '/').replace(/\\\./g, '.');
                try {
                    let m = line.match(/[a-z0-9]+\..*/g) || [''];
                    domain = GenPAC.surmiseDomain(m[0]);
                    if (domain) {
                        proxyLst.push(domain);
                        return;
                    }
                    m = line.match(/[a-z]+\.\(.*\)/g) || [''];
                    m = m[0].split(/[()]/g);
                    if (m[1]) {
                        m[1].split(/\|/g).forEach((tld) => {
                            domain = GenPAC.surmiseDomain(`${m[0]}${tld}`);
                            if (domain) {
                                proxyLst.push(domain);
                            }
                        });
                    }
                } catch (error) {
                    console.log(error);
                }
                return;
            } else if (line.startsWith('|')) {
                line = trimStart(line, '|');
            }
            domain = GenPAC.surmiseDomain(line);
            if (domain) {
                proxyLst.push(domain);
            }
        });

        proxyLst = Array.from(new Set(proxyLst));
        directLst = Array.from(new Set(directLst));

        directLst = directLst.filter(d => !proxyLst.includes(d));

        proxyLst.sort();
        directLst.sort();

        return [directLst, proxyLst];
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
            request(
                {
                    method: 'get',
                    uri: this.gfwlistUrl,
                    proxy,
                },
                (err, response, body) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(body);
                    }
                },
            );
        });
    }

    async fetchGfwlist() {
        this._ret.gfwlistFrom = '-';
        this._ret.modified = '-';
        if (this.gfwlistDisabled) {
            return [];
        }
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
            } catch (err) {
                console.log(err);
            }
        }
        if (!content) {
            if (this.gfwlistUrl !== '-' || this.gfwlistLocal) {
                GenPAC.logError('fetch gfwlist fail.', { exit: true });
            } else {
                this._ret.gfwlistFrom = '-';
            }
        }
        try {
            content = `! ${Buffer.from(content, 'base64').toString('utf8')}`;
        } catch (error) {
            GenPAC.logError('base64 decode fail.', { exit: true });
        }
        content = utils.splitLines(content);
        const lastModifiedLine = content.find(e => e.startsWith('! Last Modified:'));
        if (lastModifiedLine) {
            this._ret.modified = trim(
                lastModifiedLine
                    .split(':')
                    .slice(1)
                    .join(':'),
            );
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
                GenPAC.logError('read user rule file fail. ', f, { exit: true });
            }
        });
        return rules.concat(utils.splitLines(ruleString));
    }

    startParse(gfwlistRules, userRules) {
        const funcParse = this.precise ? GenPAC.parseRulesPrecise : GenPAC.parseRules;
        const rules = [funcParse(userRules), funcParse(gfwlistRules)];
        if (this.compress) {
            this._ret.rules = JSON.stringify(rules);
        } else {
            this._ret.rules = JSON.stringify(rules, null, 4);
        }
        this._ret.generated = new Date();
        this._ret.generated = this._ret.generated.toLocaleString();
    }

    getPacTpl() {
        let pacTpl = this.precise ? 'pac-tpl-precise.js' : 'pac-tpl.js';
        if (this.compress) {
            pacTpl = pacTpl.split('.');
            pacTpl.splice(-1, 0, 'min');
            pacTpl = pacTpl.join('.');
        }
        return fs.readFileSync(utils.pkgdata(pacTpl), {
            encoding: 'utf8',
        });
    }

    outputPac() {
        let content = this.getPacTpl();

        content = utils.replace(content, {
            __VERSION__: this._ret.version,
            __GENERATED__: this._ret.generated,
            __MODIFIED__: this._ret.modified,
            __GFWLIST_FROM__: this._ret.gfwlistFrom,
            __PROXY__: this._ret.proxy,
            __RULES__: this._ret.rules,
        });

        if (this.output && this.output !== '-') {
            fs.writeFile(utils.abspath(this.output), content, (err) => {
                if (err) {
                    GenPAC.logError(`write output file fail.\n${err}\n${this.output}`, {
                        exit: true,
                    });
                }
            });
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
