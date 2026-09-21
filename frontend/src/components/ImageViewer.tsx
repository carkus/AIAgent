import { useEffect, useRef, useState } from 'react'
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

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.page} ref={pageRef} onClick={e => e.stopPropagation()}>
        <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close image viewer">
          ✕
        </button>
        {scale !== 1 && (
          <span className={styles.zoomBadge} aria-hidden="true">{Math.round(scale * 100)}%</span>
        )}
        {svg ? (
          <div
            className={styles.image}
            style={{ transform: `scale(${scale})` }}
            onDoubleClick={() => setScale(1)}
            title="Scroll to zoom, double-click to reset"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <img
            className={styles.image}
            style={{ transform: `scale(${scale})` }}
            onDoubleClick={() => setScale(1)}
            title="Scroll to zoom, double-click to reset"
            src={src}
            alt=""
          />
        )}
      </div>
    </div>
  )
}
