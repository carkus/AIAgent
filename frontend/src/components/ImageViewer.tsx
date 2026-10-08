import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import styles from '../styles/ImageViewer.module.css'

interface Props {
  // Exactly one of these is expected: an inline SVG string (mermaid diagrams)
  // or a plain <img> src (e.g. a base64 data URL from a user's uploaded
  // diagram photo/screenshot) — same enlarge-on-tap overlay either way.
  svg?: string
  src?: string
  onClose: () => void
}

const MIN_SCALE = 0.5
const MAX_SCALE = 5
const ZOOM_STEP = 0.0015

// Full-screen viewer for a diagram tapped open from its compact inline
// preview (MermaidDiagram's 150px-tall box). Generic on purpose: as more
// visual output lands in the app, this is the shared enlarge-on-tap
// overlay rather than something built one-off into MermaidDiagram.
export default function ImageViewer({ svg, src, onClose }: Props) {
  const [scale, setScale] = useState(1)
  const pageRef = useRef<HTMLDivElement | null>(null)
  const imageRef = useRef<HTMLDivElement | HTMLImageElement | null>(null)
  // The element's own rendered "fit to page" size at scale 1 — captured once
  // it actually has a layout box, then used as the 100% reference every zoom
  // level resizes from. Resizing the real element (below) instead of only
  // painting a transform:scale() on top of an unchanged box means .page's
  // overflow:auto gets a genuine, reliably-scrollable content size.
  const [baseSize, setBaseSize] = useState<{ w: number; h: number } | null>(null)

  // Native listener, not React's onWheel — needed so preventDefault()
  // actually stops .page's own overflow:auto from scrolling underneath
  // the zoom instead of (or as well as) it.
  useEffect(() => {
    const el = pageRef.current
    if (!el) return
    function handleWheel(e: WheelEvent) {
      e.preventDefault()
      setScale(s => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s - e.deltaY * ZOOM_STEP)))
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [])

  function measureIfNeeded() {
    if (baseSize) return
    const el = imageRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) setBaseSize({ w: rect.width, h: rect.height })
  }

  // Re-measure on window resize while at rest (scale 1) so the "100%"
  // reference tracks the page's own responsive max-width/max-height rather
  // than freezing at whatever size the modal first opened at.
  useEffect(() => {
    function handleResize() {
      if (scale === 1) setBaseSize(null)
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [scale])

  useLayoutEffect(() => {
    const el = imageRef.current
    if (!el) return
    if (!baseSize) {
      measureIfNeeded()
      return
    }
    // Force the injected <svg> to fill its wrapper div (keeping its own
    // aspect ratio via viewBox) so resizing the wrapper below genuinely
    // resizes the diagram, instead of the svg staying pinned to whatever
    // intrinsic size it rendered at inside .image's old CSS max-width/
    // max-height:100% cap. Inline style, not the width/height attribute —
    // the .image svg { width: auto } class rule otherwise wins over an
    // attribute since CSS always beats a presentation attribute.
    if (svg) {
      const svgEl = el.querySelector('svg')
      if (svgEl) {
        svgEl.style.width = '100%'
        svgEl.style.height = '100%'
        // Mermaid writes an inline max-width (its natural width) onto the
        // svg, which capped it there: zooming in grew the wrapper but the
        // diagram stayed the same size. Clear it so the svg follows the
        // wrapper both ways.
        svgEl.style.maxWidth = 'none'
        svgEl.style.maxHeight = 'none'
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svg, src, baseSize])

  // maxWidth/maxHeight: 'none' overrides .image's CSS max-width/max-height:
  // 100%-of-page cap, which would otherwise clamp the element straight back
  // down the moment it's asked to grow past its original fit size.
  const sizeStyle = baseSize
    ? { width: baseSize.w * scale, height: baseSize.h * scale, maxWidth: 'none', maxHeight: 'none' }
    : undefined

  return (
    <div className={styles.overlay} onClick={onClose}>
      {/* Close button and zoom badge are fixed to the viewport, as siblings
          of .page rather than children inside it — .page scrolls internally
          when the zoomed image outgrows it, and an absolutely-positioned
          child of a scrolling container scrolls right along with its
          content. Fixed positioning outside .page keeps both anchored in
          place regardless of that internal scroll. */}
      <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close image viewer">
        ✕
      </button>
      {scale !== 1 && (
        <span className={styles.zoomBadge} aria-hidden="true">{Math.round(scale * 100)}%</span>
      )}
      <div className={styles.page} ref={pageRef} onClick={e => e.stopPropagation()}>
        {svg ? (
          <div
            ref={imageRef as RefObject<HTMLDivElement>}
            className={styles.image}
            style={sizeStyle}
            onDoubleClick={() => setScale(1)}
            title="Scroll to zoom, double-click to reset"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <img
            ref={imageRef as RefObject<HTMLImageElement>}
            className={styles.image}
            style={sizeStyle}
            onDoubleClick={() => setScale(1)}
            title="Scroll to zoom, double-click to reset"
            src={src}
            onLoad={measureIfNeeded}
            alt=""
          />
        )}
      </div>
    </div>
  )
}
