import styles from '../styles/PdfPreviewModal.module.css'

interface Props {
  blobUrl: string
  filename: string
  onDownload: () => void
  onClose: () => void
}

export default function PdfPreviewModal({ blobUrl, filename, onDownload, onClose }: Props) {
  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.title}>{filename}</span>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close preview">✕</button>
        </div>
        <iframe className={styles.frame} src={blobUrl} title="PDF preview" />
        <div className={styles.actions}>
          <button type="button" className={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button type="button" className={styles.downloadBtn} onClick={onDownload}>Download</button>
        </div>
      </div>
    </div>
  )
}
