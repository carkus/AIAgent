import { useEffect } from 'react'
import styles from '../styles/SplashScreen.module.css'
import splashLogo from '../assets/splash_logo.png'

const SPLASH_DURATION_MS = 2000

// Shown once on load, before the Setup screen — a brief branded pause on the
// centered logo rather than dropping straight into the purpose form.
export default function SplashScreen({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onDone, SPLASH_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [onDone])

  return (
    <div className={styles.root}>
      <img src={splashLogo} alt="Agent One" className={styles.logo} />
    </div>
  )
}
