# GenPAC
[![npm version](https://badge.fury.io/js/genpac.png)](https://badge.fury.io/js/genpac)

基于 gfwlist 的代理自动配置(Proxy Auto-config)文件生成工具

参考 JinnLynn 的 [genpac v1.0.3](https://github.com/JinnLynn/genpac/tree/v1.0.3)，使用 node.js 重构

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
  --proxy, -p       PAC文件中使用的代理信息                             [string]
  --gfwlist-url     gfwlist 地址，一般不需要更改              [string] [default:
         "https://raw.githubusercontent.com/gfwlist/gfwlist/master/gfwlist.txt"]
  --gfwlist-proxy   获取 gfwlist 时的代理设置，如果你可以正常访问
                    gfwlist，则无必要使用该选项                         [string]
  --user-rule       自定义规则，该选项允许重复使用                       [array]
  --user-rule-from  从文件中读取自定义规则，该选项允许重复使用           [array]
  --config-from     从文件中读取配置信息                                [string]
  --output          输出生成的文件，如果没有此选项，将直接打印结果      [string]
  --verbose         是否输出详细处理过程              [boolean] [default: false]
  -h, --help        Show help                                          [boolean]
  -v, --version     Show version number                                [boolean]
```

### 代码调用
#### 安装
```shell
npm install --save genpac
```
#### 使用
```js
var GenPAC = require('genpac');
var genpac = new GenPAC('SOCKS5 127.0.0.1:1080')
genpac.generate();
```
