Douyin Human DM — Edge 扩展说明

简介
- 这是一个在抖音 Web (douyin.com) 上模拟真人私信回复的 Chrome/Edge 扩展（content script + service worker + popup）。
- 注：仅供个人测试/学习使用。请遵循网站使用条款与相关法律法规。

目录结构（本项目）
- manifest.json         — 扩展清单（Manifest V3）
- background.js         — service worker（生命周期钩子）
- content.js            — 注入页面的自动回复逻辑（主要实现）
- popup.html            — 简单的扩展弹窗
- popup.js              — （若存在）popup 的逻辑
- README.md             — 当前文件

Edge（Chromium）安装（开发者模式）
1. 打开 Edge，访问 `edge://extensions/`。
2. 打开右下角的「开发者模式」开关。
3. 点击「加载已解压的扩展」，选择本项目文件夹（例如：`douyin-auto`）。
4. 在抖音 Web 打开私信页面，扩展会在页面注入并在右下角显示浮动控制面板。

快速测试步骤（在页面 DevTools 控制台运行）
- 检查 content script 是否注入：在控制台搜索日志 "[DY-HUMAN]"。
- 控制台测试发送按钮路径（复制粘贴运行）：
```javascript
function simulateRealClick(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 6 || r.height < 6) return false;
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const opts = { bubbles:true, cancelable:true, composed:true, view:window, clientX:x, clientY:y, pointerType:'mouse', isPrimary:true };
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
  return true;
}
(() => {
  const path = Array.from(document.querySelectorAll('path')).find(p => p.getAttribute('fill') === '#FE2C55');
  if (!path) return console.error('❌ 未找到红色发送 icon');
  const btn = path.closest('div,button,span');
  if (!btn) return console.error('❌ 未找到发送按钮父容器');
  console.log('✅ 找到发送按钮：', btn);
  simulateRealClick(btn);
})();
```
- 或使用扩展面板的「手动回复」按钮测试完整回复流程。

常用调整点
- 修改默认回复文本：在 `content.js` 顶部的 `REPLY_TEXT` 常量，或在弹窗中通过 `chrome.storage.local` 覆盖。
- 调整延迟与节流：修改 `TYPE_DELAY`、`SEND_DELAY`、`COOLDOWN` 常量以模拟不同节奏。

打包与发布
- 开发者本地调试：按上面“安装”步骤加载已解压扩展。
- 打包为 `.zip`：将项目文件夹压缩为 zip，或使用 Edge 的「打包扩展」功能生成 CRX/签名包。

调试建议
- 在 DevTools → Console 里关注前缀 `[DY-HUMAN]` 的日志。
- 如果 DOM 结构变动，需更新 `content.js` 中的选择器（脚本中包含多个回退策略）。

注意事项与风险
- 自动化消息可能违反抖音平台规则或导致账号限制，请谨慎使用。
- 本扩展直接在页面模拟事件，不进行任何远程请求或存储敏感凭证。

需要我帮助的下一步（可选）
- 我可以帮你：
  - 打包并生成一个可直接导入 Edge 的压缩包。
  - 添加 `icons` 并完善 `manifest.json`（图标、权限说明）。
  - 把一个更详细的测试用例脚本写入仓库用于本地验证。

版权所有与免责声明
- 仅为技术工具示例，不承担因使用本工具造成的任何后果。
