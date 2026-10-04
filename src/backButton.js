// Android back button → the app's home page (2026-10-04, task #555).
// Thijs: "Back space button on the screen of android, bring you back to
// dashboard page of the app?"
//
// These apps change pages in React state, not in the browser history, so the
// phone's back button had nothing of the app's own to go back to and left the
// app altogether. This keeps exactly ONE extra history step while you are on
// any page other than home:
//   - on another page, Back → the home page;
//   - on the home page, Back → leaves the app, as before.
// The URL is never changed (the step carries a marker in history.state only),
// so ?page= deep links keep working. The same file is copied into every app.
import { useEffect, useRef } from 'react'

export const BACK_MARK = 'cl-inner-page'

// Pure decisions, so tools/back_button_test.mjs can check them without a browser.
//   onNavigate: what to do with history when the page changes.
//   onPop:      what to do when the back button was pressed.
export function onNavigate({ page, home, inner }) {
  if (page === home) return inner ? 'back' : 'none'      // drop our extra step quietly
  return inner ? 'replace' : 'push'                         // one step, never a stack of them
}
export function onPop({ page, home, inner }) {
  if (!inner && page !== home) return 'go-home'
  return 'none'
}

export function useBackToHome({ page, setPage, home }) {
  const ignoreNextPop = useRef(false)
  const latest = useRef({ page, home, setPage })
  latest.current = { page, home, setPage }

  useEffect(() => {
    if (typeof window === 'undefined' || !window.history || !home) return
    const inner = window.history.state?.[BACK_MARK] === true
    const action = onNavigate({ page, home, inner })
    if (action === 'push') window.history.pushState({ ...(window.history.state || {}), [BACK_MARK]: true }, '')
    else if (action === 'replace') window.history.replaceState({ ...(window.history.state || {}), [BACK_MARK]: true }, '')
    else if (action === 'back') { ignoreNextPop.current = true; window.history.back() }
  }, [page, home])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onPopState = (e) => {
      if (ignoreNextPop.current) { ignoreNextPop.current = false; return }
      const { page: p, home: h, setPage: set } = latest.current
      const inner = e.state?.[BACK_MARK] === true
      if (onPop({ page: p, home: h, inner }) === 'go-home') set(h)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])
}
