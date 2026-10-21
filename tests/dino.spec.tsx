import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DinoGame } from '../src/client/DinoGame.tsx'
import { dinoAsset } from '../src/assets.ts'

const root = fileURLToPath(new URL('../dino/', import.meta.url))

describe('小恐龙彩蛋（vendored 开源实现）', () => {
  it('ships the upstream game files untouched', () => {
    for (const file of ['index.html', 'style.css', 'js/game.js', 'js/objects/dinosaur.js', 'LICENSE', 'ATTRIBUTION.md']) {
      expect(existsSync(root + file), file).toBe(true)
    }
    const html = readFileSync(root + 'index.html', 'utf8')
    expect(html).toContain('js/game.js')
    expect(readFileSync(root + 'ATTRIBUTION.md', 'utf8')).toContain('CloudCannon/Dinosaur-Chrome-Game')
    expect(readFileSync(root + 'LICENSE', 'utf8')).toContain('MIT')
  })

  it('serves only whitelisted dino assets with the right content types', () => {
    expect(dinoAsset('index.html')).toMatchObject({ type: 'text/html; charset=utf-8' })
    expect(dinoAsset('js/game.js')).toMatchObject({ type: 'text/javascript; charset=utf-8' })
    expect(dinoAsset('style.css')).toMatchObject({ type: 'text/css; charset=utf-8' })
    expect(dinoAsset('js/game.js').path.replace(/\\/g, '/').endsWith('dino/js/game.js')).toBe(true)
    // 白名单之外一律 404，URL 里的路径拼接不生效。
    expect(() => dinoAsset('../../package.json')).toThrowError(/dino asset not found/)
    expect(() => dinoAsset('js/vendor/jquery.js')).toThrowError(/dino asset not found/)
  })

  it('renders the game in the whole editor panel through an iframe', () => {
    const html = renderToStaticMarkup(<DinoGame onExit={() => {}}/>)
    expect(html).toContain('/dsh-vscode/dino/index.html')
    expect(html).toContain('dvw-dino-frame')
    expect(html).toContain('aria-label="退出小游戏"')
  })

  it('is triggered by hovering the teaser line only, not by clicking the whole empty state', () => {
    const source = readFileSync(new URL('../src/client/Workbench.tsx', import.meta.url), 'utf8')
    expect(source).toContain('或者，你想试试玩谷歌小恐龙吗？')
    expect(source).toContain('<DinoGame onExit')
    // 触发点是那一行小字（button），不再是整块空状态的 onClick。
    expect(source).toContain('className="dvw-dino-teaser" onClick={()=>setDino(true)}')
    expect(source).not.toContain('dvw-empty-dino" role="button"')
    expect(source).not.toContain('onClick={()=>setDino(true)} onKeyDown=')
  })
})
