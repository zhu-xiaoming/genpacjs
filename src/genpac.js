const fs = require('fs');
const nodeUtil = require('util');

const _ = require('lodash');
const ConfigParser = require('configparser');
const request = require('request-promise');

const utils = require('./utils');

const VERSION = '1.0.0';
const DEFAULT_GFWLIST_URL = 'http://autoproxy-gfwlist.googlecode.com/svn/trunk/gfwlist.txt';

const pacComment = (version, generatedTime, lastModified) => `/**
 * genpac ${version}
 * Generated: ${generatedTime}
 * GFWList Last-Modified: ${lastModified}
 */
`;

const PAC_FUNCS = `
var regExpMatch = function(url, pattern) {
    try {
        return new RegExp(pattern).test(url);
    } catch(ex) {
        return false;
    }
};

var testURL = function(url, pack) {
    var D = "DIRECT",
        P = config[0],
        j = 0;
    for (j in pack[0])
        if(regExpMatch(url, pack[0][j])) return D;
    for (j in pack[1])
        if (shExpMatch(url, pack[1][j])) return D;
    for (j in pack[2])
        if(regExpMatch(url, pack[2][j])) return P;
    for (j in pack[3])
        if(shExpMatch(url, pack[3][j])) return P;
};

function FindProxyForURL(url, host) {
    for (var i = 1; i < config.length; i++) {
        var ret = testURL(url, config[i]);
        if (ret !== undefined)
            return ret;
    }
    return "DIRECT";
}
`;

const PROXY_TYPE = {
    PROXY_TYPE_SOCKS4: 1,
    PROXY_TYPE_SOCKS5: 2,
    PROXY_TYPE_HTTP: 3,
};

const PROXY_TYPE_MAP = {
    SOCKS: PROXY_TYPE.PROXY_TYPE_SOCKS4,
    SOCKS5: PROXY_TYPE.PROXY_TYPE_SOCKS5,
    PROXY: PROXY_TYPE.PROXY_TYPE_HTTP,
};

class GenPAC {
    constructor(
        pacProxy = null,
        gfwlistURL = DEFAULT_GFWLIST_URL,
        gfwlistProxy = null,
        userRules = [],
        userRuleFiles = [],
        configFile = null,
        outputFile = null,
        verbose = false,
    ) {
        this.verbose = verbose;

        this.logger = console;

        // 直接输入的参数优先级高于config文件
        this.configFile = configFile;
        const cfg = this.readConfig(utils.abspath(this.configFile));

        const getCfg = _.curry(_.get)(cfg);
        this.pacProxy = pacProxy || getCfg('pacProxy')(null);
        this.gfwlistURL = gfwlistURL || getCfg('gfwlistURL')(DEFAULT_GFWLIST_URL);
        this.gfwlistProxy = gfwlistProxy || getCfg('gfwlistProxy')(null);
        this.userRules = userRules || [];
        this.userRuleFiles = userRuleFiles || getCfg('userRuleFiles')([]);
        this.outputFile = outputFile || getCfg('outputFile')(null);

        this.gfwlistModified = '';
        this.gfwlistContent = '';
        this.userRulesContent = '';
        this.pacContent = '';

        if (!fs.existsSync('tmp') || !fs.statSync('tmp').isDirectory()) {
            fs.mkdirSync('tmp');
        }
        // 清空 tmp 文件夹
        utils.rmdirSyncR('tmp', false);
    }

    // 解析条件
    static parseRules(ruleString) {
        const directWildcardList = [];
        const directRegexpList = [];
        const proxyWildcardList = [];
        const proxyRegexpList = [];
        const ruleList = ruleString.split(/\r?\n/);

        ruleList.forEach((l) => {
            let line = utils.strip(l);
            // 忽略注释
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
                line = GenPAC.wildcardToRegexp(line);
                line = line.replace(/\\\^/g, String.raw`(?:[^\w\-.%\u0080-\uFFFF]|$)`);
            } else if (line.startsWith('||')) {
                line = GenPAC.wildcardToRegexp(line.slice(2));
                line = String.raw`^[\w\-]+:\/+(?!\/)(?:[^\/]+\.)?` + line;
            } else if (line.startsWith('|') || line.endsWith('|')) {
                line = GenPAC.wildcardToRegexp(line);
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
                    directRegexpList.push(line);
                } else {
                    directWildcardList.push(line);
                }
            } else if (isRegexp) {
                proxyRegexpList.push(line);
            } else {
                proxyWildcardList.push(line);
            }
        });

        return [directRegexpList, directWildcardList, proxyRegexpList, proxyWildcardList];
    }

    static wildcardToRegexp(pattern) {
        let p = pattern.replace(/([\\+|{}[\]()^$.#])/g, String.raw`\$1`);
        p = p.replace(/\*/g, String.raw`.*`);
        p = p.replace(/\？/g, String.raw`.`);
        return p;
    }

    async generate() {
        const options = `Configuration:
        proxy           : ${this.pacProxy}
        gfwlist url     : ${this.gfwlistURL}
        gfwlist proxy   : ${this.gfwlistProxy}
        user rule       : ${Array.isArray(this.userRules) ? this.userRules.join(' ') : 'null'}
        user rule file  : ${Array.isArray(this.userRuleFiles) ? this.userRuleFiles.join(' ') : 'null'}
        config file     : ${this.configFile}
        output file     : ${this.outputFile}
        `;
        this.logger.info(options);

        // pac的代理配置不检查准确性
        if (!this.pacProxy) {
            this.die('没有配置proxy');
        }

        await this.fetchGFWList();
        this.getUserRules();
        this.generatePACContent();
        this.generatePACFile();
    }

    readConfig(configFile) {
        function getv(c, k, d) {
            try {
                return utils.strip(c.get('config', k), ' \'\t"');
            } catch (error) {
                return d;
            }
        }
        if (!configFile) {
            return {};
        }
        try {
            const configFileAbspath = utils.abspath(configFile);
            const cfg = new ConfigParser();
            cfg.read(configFileAbspath);
            const userRuleFiles = getv(cfg, 'user-rule-from', null);
            return {
                pacProxy: getv(cfg, 'proxy', null),
                gfwlistURL: getv(cfg, 'gfwlist-url', DEFAULT_GFWLIST_URL),
                gfwlistProxy: getv(cfg, 'gfwlist-proxy', null),
                // user_rule_files 应该是个列表
                userRuleFiles: userRuleFiles ? [userRuleFiles] : [],
                outputFile: getv(cfg, 'output', null),
            };
        } catch (error) {
            return this.die(`配置文件 ${configFile} 读取错误: ${error}'`);
        }
    }

    die(msg) {
        this.logger.error(msg);
        process.exit(1);
    }

    // 下载 gfwlist
    async fetchGFWList() {
        this.logger.info('gfwlist 获取中 ...');

        // 设置 debug
        if (this.verbose) {
            request.debug = true;
        }

        try {
            if (this.gfwlistURL) {
                let proxy;
                // 设置代理
                if (this.gfwlistProxy) {
                    const [input, proxyType, proxyUser, proxyPwd, proxyHost, proxyPort] = this.gfwlistProxy.match(/(PROXY|SOCKS|SOCKS5) (?:(.+):(.+)@)?(.+):(\d+)/i);
                    if (PROXY_TYPE_MAP[proxyType] === PROXY_TYPE.PROXY_TYPE_HTTP) {
                        proxy = 'http://';
                    } else {
                        proxy = `${proxyType}://`;
                    }
                    if (proxyUser || proxyPwd) {
                        proxy = `${proxy}${proxyUser}:${proxyPwd}@`;
                    }
                    proxy = `${proxy}${proxyHost}:${proxyPort}`;
                }
                const res = await request({
                    method: 'get',
                    uri: this.gfwlistURL,
                    proxy,
                });
                this.gfwlistModified = res['last-modified'] || '';

                fs.writeFile(
                    'tmp/origin_gfwlist.txt',
                    res,
                    err => err && this.logger.error(err),
                );

                this.gfwlistContent = this.decodeGFWList(res);
            } else if (fs.existsSync('tmp/origin_gfwlist.txt')) {
                const res = (await nodeUtil.promisify(fs.readFile)(
                    'tmp/origin_gfwlist.txt',
                )).toString();
                this.gfwlistModified = res['last-modified'] || '';
                this.gfwlistContent = this.decodeGFWList(res);
            }
            this.logger.info(`gfwlist已成功获取，更新时间: ${this.gfwlistModified}`);
        } catch (error) {
            this.die(`GFWList 获取失败: ${error}。`);
        }
    }

    decodeGFWList(originGFWList) {
        const gfwlist = Buffer.from(originGFWList, 'base64');
        if (this.verbose) {
            fs.writeFile('tmp/gfwlist.txt', gfwlist, err => err && this.logger.error(err));
        }
        //! gfwlist文件内容的第一行内容是不符合语法规则的
        //! 手动将其注释掉
        return `! ${gfwlist.toString()}`;
    }

    // 获取用户定义的规则
    getUserRules() {
        this.logger.info('获取用户自定义规则...');
        // userRules 优先级高于 userRuleFiles
        let rules = this.userRules.join('\n');
        this.userRuleFiles.forEach((f) => {
            if (!f) {
                return;
            }
            const file = utils.abspath(f);
            try {
                rules = `${rules}\n${fs.readFileSync(file)}`;
            } catch (error) {
                this.die(`读取用户自定义规则文件${f}错误: ${error}`);
            }
        });
        this.userRulesContent = rules;
    }

    generatePACContent() {
        this.logger.info('解析规则并生成PAC内容...');
        let config = [
            this.pacProxy,
            GenPAC.parseRules(this.userRulesContent),
            GenPAC.parseRules(this.gfwlistContent),
        ];
        config = `var config = ${JSON.stringify(config, null, 4)};`;
        const comment = pacComment(VERSION, new Date(), this.gfwlistModified);
        this.pacContent = `${comment}\n${config}\n${PAC_FUNCS}`;
    }

    generatePACFile(callback) {
        if (!this.pacContent) {
            this.logger.error('没有生成 PAC 内容，无法生成 PAC 文件');
            return;
        }
        if (!this.outputFile) {
            console.info(this.pacContent);
            return;
        }
        const output = utils.abspath(this.outputFile);
        fs.writeFile(output, this.pacContent, (err) => {
            if (err) {
                this.die(`写入文件${output}失败: ${err}`);
            }
            console.info(`PAC 文件已生成: ${output}`);
            callback && callback();
        });
    }
}

module.exports = GenPAC;
