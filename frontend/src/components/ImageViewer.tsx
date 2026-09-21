import styles from '../styles/ImageViewer.module.css'

interface Props {
  svg: string
  onClose: () => void
}

// Full-screen viewer for a diagram tapped open from its compact inline
// preview (MermaidDiagram's 150px-tall box). Generic on purpose: as more
// visual output lands in the app, this is the shared enlarge-on-tap
// overlay rather than something built one-off into MermaidDiagram.
export default function ImageViewer({ svg, onClose }: Props) {
  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.page} onClick={e => e.stopPropagation()}>
        <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close image viewer">
          ✕
        </button>
        <div className={styles.image} dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
    </div>
  )
}
