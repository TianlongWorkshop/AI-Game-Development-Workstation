'use strict';
// UE 代码测试：中文 Windows 上 MSVC 输出是 GBK，需要正确解码并提取错误
const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../ue-tools.cjs');

test('UBT 日志：GBK 输出正确解码、提取编译错误与实时编码冲突', () => {
  const gbkMsg = Buffer.from([0xce, 0xb4, 0xc9, 0xf9, 0xc3, 0xf7, 0xb5, 0xc4, 0xb1, 0xea, 0xca, 0xb6, 0xb7, 0xfb]); // “未声明的标识符”
  const log = U.decodeLog(Buffer.concat([Buffer.from('[1/4] Compile [x64] ShooterWeapon.cpp\r\nE:\\P\\ShooterWeapon.cpp(196,2): error C2065: "RefireRat": '), gbkMsg]));
  assert.match(log, /未声明的标识符/);
  assert.equal(U.decodeLog(Buffer.from('普通 UTF-8 日志')), '普通 UTF-8 日志');
  const errs = U.extractErrors(log + '\r\nResult: Failed (OtherCompilationError)\r\nUnable to build while Live Coding is active. Exit the editor and game, or press Ctrl+Alt+F11 if iterating on code in the editor or game');
  assert.equal(errs.length, 2);
  assert.equal(U.extractErrors('LINK : fatal error LNK1104: cannot open file \'E:\\P\\Binaries\\Win64\\UnrealEditor-P.dll\'').length, 1);
  assert.match(errs[0], /C2065/);
  assert.match(errs[1], /Live Coding/);
});
