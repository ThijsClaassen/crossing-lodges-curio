import { useEffect, useRef, useState } from 'react'
import { BrowserMultiFormatReader } from '@zxing/browser'
import { colors, fonts } from './theme.js'

// Full-screen camera overlay that continuously reads 1D barcodes (UPC/EAN)
// from the device's rear camera and reports each decoded value via onScan.
// Used by the Count tab's "Scan mode." Requires HTTPS (Vercel provides
// this) and a camera permission prompt the first time it's used.

export default function BarcodeScanner({ onScan, onClose }) {
  const videoRef = useRef(null)
  const controlsRef = useRef(null)
  const lastScanRef = useRef({ code: '', time: 0 })
  const [error, setError] = useState('')

  useEffect(() => {
    const reader = new BrowserMultiFormatReader()
    let cancelled = false

    reader
      .decodeFromConstraints(
        { audio: false, video: { facingMode: 'environment' } },
        videoRef.current,
        (result) => {
          if (cancelled || !result) return
          const code = result.getText()
          const now = Date.now()
          // The camera re-decodes the same barcode on every frame while it's
          // in view — ignore repeats of the same code within 2s so one scan
          // doesn't fire the callback dozens of times.
          if (code === lastScanRef.current.code && now - lastScanRef.current.time < 2000) return
          lastScanRef.current = { code, time: now }
          // Stop the camera/decode loop BEFORE telling the parent about the
          // scan. The parent responds by closing this overlay, which
          // unmounts this component — if the decoder is still mid-frame
          // when that happens, it can throw trying to read a video element
          // that's already gone, which crashed the whole app to a blank
          // white screen. Stopping first avoids that race entirely.
          controlsRef.current?.stop()
          onScan(code)
        }
      )
      .then((controls) => {
        if (cancelled) {
          controls.stop()
        } else {
          controlsRef.current = controls
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || 'Could not access the camera.')
      })

    return () => {
      cancelled = true
      controlsRef.current?.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.85)',
        zIndex: 50,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div style={{ width: '100%', maxWidth: 480 }}>
        <video
          ref={videoRef}
          style={{
            width: '100%',
            borderRadius: 12,
            border: `2px solid ${colors.gold}`,
            background: '#000',
          }}
          muted
          playsInline
        />
        <div style={{ fontFamily: fonts.body, color: colors.cream, fontSize: 13, textAlign: 'center', margin: '12px 0' }}>
          Point the camera at an item's barcode.
        </div>
        {error && (
          <div style={{ color: colors.danger, fontSize: 12, textAlign: 'center', marginBottom: 12 }}>{error}</div>
        )}
        <button
          onClick={onClose}
          style={{
            display: 'block',
            margin: '0 auto',
            padding: '9px 18px',
            borderRadius: 8,
            border: `1px solid ${colors.gold}`,
            background: 'transparent',
            color: colors.goldLt,
            fontFamily: fonts.body,
            fontWeight: 600,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Stop scanning
        </button>
      </div>
    </div>
  )
}
