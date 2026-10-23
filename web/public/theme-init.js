// 在页面渲染前应用深色主题，避免闪白。
// 独立成文件而不是内联脚本，是为了符合只允许本站脚本的 CSP。
try {
  var stored = localStorage.getItem('minddock-theme')
  var dark = stored === 'dark' || (stored !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
  if (dark) document.documentElement.classList.add('dark')
} catch {
  // 存储不可用时按浅色显示，ThemeProvider 加载后会再修正
}
