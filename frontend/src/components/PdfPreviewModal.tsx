import styles from '../styles/PdfPreviewModal.module.css'

interface Props {
  blobUrl: string
  filename: string
  onDownload: () => void
  onSaveJson: () => void
  onClose: () => void
}

// The PDF is a read-only rendering — there's no way to get this conversation
// back into the app from it. "Save Chat File" downloads the same transcript
// as JSON (the SavedChat shape Chat.tsx already uses for its own localStorage
// saves), a format Setup.tsx's "Load Chat File" picker can read back in to
// actually resume the conversation later, on this device or a different one.
export default function PdfPreviewModal({ blobUrl, filename, onDownload, onSaveJson, onClose }: Props) {
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
          <button
            type="button"
            className={styles.saveJsonBtn}
            onClick={onSaveJson}
            title="Save this conversation as a JSON file you can reload later"
          >
            Save Chat File
          </button>
          <button type="button" className={styles.downloadBtn} onClick={onDownload}>Download PDF</button>
        </div>
      </div>
    </div>
  )
}
