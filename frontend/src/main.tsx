import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import type { Bootstrap } from './types'
import './styles.css'

/** Django 用 json_script 注入，读它比自己拼字符串安全（不会撞上 </script>）。 */
function readBootstrap(): Bootstrap {
  const node = document.getElementById('bootstrap')
  if (!node?.textContent) {
    throw new Error('缺少 #bootstrap 数据 —— 确认模板里有 {{ bootstrap|json_script }}')
  }
  return JSON.parse(node.textContent) as Bootstrap
}

const root = document.getElementById('root')
if (!root) throw new Error('缺少 #root 挂载点')

createRoot(root).render(
  <StrictMode>
    <App bootstrap={readBootstrap()} />
  </StrictMode>,
)
