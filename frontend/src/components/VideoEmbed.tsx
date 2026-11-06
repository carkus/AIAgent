// Inline video player for a video link in an agent reply: YouTube, Vimeo or
// a direct video file. Plays in the chat scroll, not in an overlay — the
// player's own fullscreen button covers that case.
//
// Click-to-load: a reply can carry several links, so each starts as a still
// card and only mounts the real player (an iframe or <video>) when clicked.
//
// Everything here is phrasing content (span, button, iframe, video) because
// ReactMarkdown renders links inside a <p>; a <div> there is invalid HTML.
import { useState } from 'react'
import styles from '../styles/VideoEmbed.module.css'

export type VideoSource =
  | { kind: 'youtube'; id: string; start?: number }
  | { kind: 'vimeo'; id: string }
  | { kind: 'file'; url: string }

const YT_ID = /^[A-Za-z0-9_-]{11}$/
const FILE_EXT = /\.(mp4|webm|ogv|mov|m4v)$/i

function parseSeconds(t: string | null): number | undefined {
  if (!t) return undefined
  if (/^\d+$/.test(t)) return Number(t)
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t)
  if (!m || !m[0]) return undefined
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
}

export function parseVideoUrl(href: string | undefined): VideoSource | null {
  if (!href) return null
  let u: URL
  try { u = new URL(href) } catch { return null }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const host = u.hostname.replace(/^(www\.|m\.)/, '')
  const start = parseSeconds(u.searchParams.get('t') ?? u.searchParams.get('start'))

  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0]
    return YT_ID.test(id) ? { kind: 'youtube', id, start } : null
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const parts = u.pathname.split('/').filter(Boolean)
    const id = parts[0] === 'watch' ? u.searchParams.get('v') ?? ''
      : ['embed', 'shorts', 'live', 'v'].includes(parts[0]) ? parts[1] ?? ''
      : ''
    return YT_ID.test(id) ? { kind: 'youtube', id, start } : null
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = u.pathname.split('/').filter(Boolean).find(p => /^\d+$/.test(p))
    return id ? { kind: 'vimeo', id } : null
  }
  if (FILE_EXT.test(u.pathname)) return { kind: 'file', url: u.href }
  return null
}

function embedUrl(v: VideoSource): string {
  if (v.kind === 'youtube') {
    const q = new URLSearchParams({ autoplay: '1', rel: '0' })
    if (v.start) q.set('start', String(v.start))
    return `https://www.youtube-nocookie.com/embed/${v.id}?${q}`
  }
  if (v.kind === 'vimeo') return `https://player.vimeo.com/video/${v.id}?autoplay=1&dnt=1`
  return v.url
}

interface Props {
  video: VideoSource
  href: string
  title: string
}

export default function VideoEmbed({ video, href, title }: Props) {
  const [playing, setPlaying] = useState(false)
  const thumb = video.kind === 'youtube' ? `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg` : null

  return (
    <span className={styles.card}>
      <span className={styles.frame}>
        {video.kind === 'file' ? (
          // Native player: controls from the start, only metadata preloaded.
          <video className={styles.media} src={video.url} controls preload="metadata" />
        ) : playing ? (
          <iframe
            className={styles.media}
            src={embedUrl(video)}
            title={title}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <button
            type="button"
            className={styles.poster}
            onClick={() => setPlaying(true)}
            aria-label={`Play video: ${title}`}
          >
            {thumb && <img className={styles.media} src={thumb} alt="" loading="lazy" />}
            <span className={styles.play} aria-hidden="true">▶</span>
          </button>
        )}
      </span>
      <a className={styles.caption} href={href} target="_blank" rel="noopener noreferrer">
        {title} ↗
      </a>
    </span>
  )
}

function plainText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(plainText).join('')
  if (typeof node === 'object' && 'props' in node) {
    return plainText((node as React.ReactElement<{ children?: React.ReactNode }>).props.children)
  }
  return ''
}

// ReactMarkdown `a` renderer: a video link becomes an inline player, every
// other link renders as before.
export function MarkdownLink({ href, children, node: _node, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  const video = parseVideoUrl(href)
  if (!video || !href) return <a href={href} {...props}>{children}</a>
  const text = plainText(children).trim()
  const fallback = video.kind === 'youtube' ? 'Watch on YouTube' : video.kind === 'vimeo' ? 'Watch on Vimeo' : 'Open video'
  const title = text && text !== href ? text : fallback
  return <VideoEmbed video={video} href={href} title={title} />
}
