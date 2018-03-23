module.exports = {
  extends: 'airbnb-base',
  env: {
    commonjs: true,
    es6: true,
    node: true,
  },
  rules: {
    "function-paren-newline": 'off',
    "indent": ["error", 4, {
      "SwitchCase": 1,
      "VariableDeclarator": 1,
      "outerIIFEBody": 1,
      "FunctionDeclaration": {
        "parameters": 1,
        "body": 1
      },
      "FunctionExpression": {
        "parameters": 1,
        "body": 1
      }
    }],
  },
};
