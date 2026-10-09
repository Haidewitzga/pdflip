import { describe, expect, it } from 'vitest'
import { renderScale } from '../pdfToCards'

describe('card image resolution', () => {
  it('renders the placed region at 2 pixels per card point', () => {
    // whole landscape page placed 1000 pt wide → 2000 px across the page
    expect(renderScale({ w: 500, h: 300 }, undefined, 1000) * 500).toBeCloseTo(2000)
    // half-width crop placed 1000 pt wide → 2000 px across the crop
    const s = renderScale({ w: 500, h: 300 }, { x: 0, y: 0, w: 0.5, h: 1 }, 1000)
    expect(s * 250).toBeCloseTo(2000)
  })

  it('stays below the iPad canvas size limit', () => {
    const page = { w: 595, h: 842 }
    const s = renderScale(page, { x: 0, y: 0, w: 0.1, h: 0.1 }, 1100)
    expect(page.w * s * page.h * s).toBeLessThanOrEqual(12_000_001)
  })
})
