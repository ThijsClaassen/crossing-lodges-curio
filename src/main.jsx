import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

// Without this, any uncaught error anywhere in the app (a bad camera
// callback, a network hiccup mid-render, anything) unmounts the whole
// React tree and leaves a totally blank white screen with no way back
// short of a manual reload. This catches that and shows a recoverable
// message instead.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidCatch(error, info) {
    console.error('Uncaught error:', error, info)
  }
  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            padding: 24,
            textAlign: 'center',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            background: '#1E1D2B',
            color: '#F0EDE6',
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 600 }}>Something went wrong.</div>
          <div style={{ fontSize: 13, color: '#8A8899', maxWidth: 320 }}>
            {this.state.error?.message || 'An unexpected error occurred.'}
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: 8,
              padding: '9px 18px',
              borderRadius: 8,
              border: 'none',
              background: '#3C3B5A',
              color: '#F0EDE6',
              fontWeight: 600,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
