// boot.js —— Vite 入口：先挂顶层错误兜底，再加载主程序。
// 任何模块加载/运行期异常都落到 #fatal，绝不留白屏无提示。
const fatal = document.getElementById('fatal');

function showFatal(msg) {
  fatal.textContent = String(msg);
  fatal.style.display = 'flex';
  document.getElementById('hint').classList.add('hidden');
}

window.addEventListener('error', (e) => showFatal('运行出错：\n' + (e.error?.stack || e.message)));
window.addEventListener('unhandledrejection', (e) => showFatal('运行出错：\n' + (e.reason?.stack || e.reason)));

import('./main.js').catch((err) => showFatal('加载失败：\n' + (err?.stack || err)));
