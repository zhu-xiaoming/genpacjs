# GenPAC
[![npm version](https://img.shields.io/npm/v/genpac.svg?style=flat-square)](https://www.npmjs.com/package/genpac)

基于 gfwlist 的代理自动配置(Proxy Auto-config)文件生成工具

参考 JinnLynn 的 [genpac v1.3.1](https://github.com/JinnLynn/genpac/tree/v1.3.1)，使用 node.js 重构

## 安装与使用

### 命令行使用
#### 安装
```shell
npm install -g genpac
```
#### 使用
```
Usage: genpac [options]

Options:
  --proxy, -p             PAC文件中使用的代理信息                         [string]
  --gfwlist-url           gfwlist 网址, 无此参数或参数为空则使用默认地址,
                          参数为-则不在线获取                 [string] [default:
         "https://raw.githubusercontent.com/gfwlist/gfwlist/master/gfwlist.txt"]
  --gfwlist-proxy         获取 gfwlist 时的代理设置, 如果你可以正常访问 gfwlist,
                          则无必要使用该选项                              [string]
  --gfwlist-local         本地 gfwlist 文件地址, 当在线地址获取失败时使用
                                                                        [string]
  --update-gfwlist-local  当在线 gfwlist 成功获取且 gfwlist-local 存在时,
                          默认会将在线内容覆盖到本地, 此项设置后则不覆盖
                                                       [boolean] [default: true]
  --user-rule             自定义规则, 该参数允许重复使用                   [array]
  --user-rule-from        从文件中读取自定义规则, 该参数允许重复使用        [array]
  --config-from           从文件中读取配置信息                            [string]
  --output, -o            输出生成的文件, 如果没有此参数或参数为-,
                          将直接打印结果                                 [string]
  --compress, -z          压缩输出                     [boolean] [default: false]
  --base64                base64加密输出, 注意:
                          部分浏览器并不支持经过base64加密的pac文件
                                                      [boolean] [default: false]
  --init                  初始化配置和用户规则文件                        [string]
  -h, --help              Show help                                    [boolean]
  -v, --version           Show version number                          [boolean]
```

### 代码调用
#### 安装
```shell
npm install --save genpac
```
#### 使用
```js
var GenPAC = require('genpac');
var genpac = new GenPAC()
genpac.generate();
```

## 配置

支持通过 `--config-from` 参数读入配置信息，配置文件书写方法可参考 [config-sample.ini](https://github.com/little-tomorrow/genpacjs/blob/dev/src/res/config-sample.ini)

## 自定义的代理规则

支持通过 `--user-rule` 自定义单个规则或 `--user-rule-from` 读入自定义规则文件，这两个参数均可重复使用。

自定义规则文件可参考 [user-rules-sample.txt](https://github.com/little-tomorrow/genpacjs/blob/dev/src/res/user-rules-sample.txt)

自定义规则的语法与 gfwlist 相同，使用 AdBlock Plus 过滤规则( http://adblockplus.org/en/filters )，简述如下:
  
1. 通配符支持，如 `*.example.com/*` 实际书写时可省略 `*` 为 `.example.com/`
2. 正则表达式支持，以 `\` 开始和结束， 如 `\[\w]+:\/\/example.com\\`
3. 例外规则 `@@`，如 `@@*.example.com/*` 满足 `@@` 后规则的地址不使用代理
4. 匹配地址开始和结尾 `|`，如 `|http://example.com`、`example.com|` 分别表示以 `http://example.com` 开始和以 `example.com` 结束的地址
5. `||` 标记，如 `||example.com` 则 `http://example.com https://example.com ftp://example.com` 等地址均满足条件
6. 注释 `!` 如 `! Comment`

配置自定义规则时需谨慎，尽量避免与gfwlist产生冲突，或将一些本不需要代理的网址添加到代理列表

规则优先级从高到底为: user-rule > user-rule-from > gfwlist

## LICENSE

The MIT License.
