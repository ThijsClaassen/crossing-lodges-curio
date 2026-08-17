// Crossing Lodges shared brand palette (same tokens as every other app in
// this family), pulled out of App.jsx so other components (e.g.
// BarcodeScanner.jsx) can use the same colors without a circular import
// back into App.jsx.

export const colors = {
  bg: '#1E1D2B',
  panel: '#28273A',
  border: '#3A3850',
  cream: '#F0EDE6',
  muted: '#8A8899',
  navy: '#3C3B5A',
  navyLt: '#4E4D72',
  gold: '#B8935A',
  goldLt: '#D4AF7A',
  ok: '#5A9B72',
  danger: '#C05858',
  loc: { ZC: '#B8935A', EC: '#5B8CC4', SC: '#7BAE7F' },
}

export const fonts = {
  body: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  heading: "'Cormorant Garamond', serif",
  mono: "'Space Mono', monospace",
}

// Left-sidebar shell CSS (2026-08-17) — ports the Ops/Maintenance app's
// `.shell`/`.sidebar`/`.nav` layout system into this app so the desktop menu
// bar matches theirs: logo + company/location switcher + tabs top-to-bottom
// on the left, footer with role badge/refresh/sign-out at the bottom.
// Class names deliberately match Ops's theme.js 1:1 (see that file) so any
// future layout tweak can be copied across every app without translation.
// Display toggling between the sidebar and the mobile bottom-sheet nav is
// done purely via these CSS classes (no inline `display` style on the
// elements themselves) — an inline style would always win over a
// non-`!important` media-query rule, which is exactly the trap the app's
// old `.desktop-tab-row`/`.mobile-nav-bar` inline-styled version fell into.
export const css = `
  body{background:${colors.bg};color:${colors.cream};font-family:'Inter',sans-serif}
  .shell{display:flex;min-height:100vh;background:${colors.bg};color:${colors.cream}}
  .sidebar{width:230px;background:${colors.panel};border-right:1px solid ${colors.border};display:flex;flex-direction:column;flex-shrink:0;position:sticky;top:0;height:100vh;overflow-y:auto}
  .main{flex:1;min-width:0;background:${colors.bg};color:${colors.cream}}
  .bottom-nav{display:none}

  .sidebar-logo{padding:20px 18px 16px;border-bottom:1px solid ${colors.border};display:flex;flex-direction:column;align-items:center;gap:8px}
  .sidebar-logo img{width:140px;height:auto;filter:brightness(0) invert(1) opacity(0.92)}
  .sidebar-sub{font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:${colors.gold};font-weight:600;text-align:center;opacity:.85}
  .sidebar-company{font-size:11px;color:${colors.muted};text-align:center}

  .sidebar-select-wrap{padding:10px 13px;border-bottom:1px solid ${colors.border}}
  .sidebar-select{width:100%;background:rgba(0,0,0,.25);border:1px solid ${colors.border};border-radius:6px;padding:7px 9px;color:${colors.cream};font-family:'Inter',sans-serif;font-size:12px}
  .sidebar-select option{background:${colors.panel}}

  .loc-switcher{padding:12px 13px;border-bottom:1px solid ${colors.border};display:flex;flex-direction:column;gap:3px}
  .loc-label{font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:${colors.muted};font-weight:600;margin-bottom:5px;padding-left:2px}
  .loc-btn{padding:7px 11px;border-radius:6px;border:1px solid transparent;font-family:'Inter',sans-serif;font-size:12px;font-weight:500;cursor:pointer;text-align:left;transition:all .15s;background:transparent;color:${colors.muted};display:flex;align-items:center;gap:8px;width:100%}
  .loc-btn:hover{color:${colors.cream};background:rgba(255,255,255,.04)}
  .loc-btn.active-ZC{background:rgba(184,147,90,.15);border-color:rgba(184,147,90,.45);color:${colors.gold}}
  .loc-btn.active-EC{background:rgba(91,140,196,.15);border-color:rgba(91,140,196,.45);color:${colors.loc.EC}}
  .loc-btn.active-SC{background:rgba(123,174,127,.15);border-color:rgba(123,174,127,.45);color:${colors.loc.SC}}
  .loc-dot{display:inline-block;width:7px;height:7px;border-radius:50%;flex-shrink:0}

  .period-wrap{padding:10px 13px;border-bottom:1px solid ${colors.border}}

  .nav{flex:1;padding:8px 0;overflow-y:auto}
  .nav-item{display:block;width:100%;text-align:left;padding:9px 18px;cursor:pointer;font-size:13px;font-weight:500;color:${colors.muted};transition:all .15s;border:none;background:none;border-right:2px solid transparent;letter-spacing:.01em}
  .nav-item:hover{color:${colors.cream};background:rgba(184,147,90,.06)}
  .nav-item.active{color:${colors.gold};background:rgba(184,147,90,.12);border-right-color:${colors.gold};font-weight:600}

  .sidebar-footer{padding:13px 18px;border-top:1px solid ${colors.border};font-size:10px;color:${colors.muted};line-height:1.6}
  .sidebar-footer-row{display:flex;gap:10px;margin-top:6px}
  .sidebar-footer-btn{background:none;border:none;color:${colors.muted};font-size:10px;cursor:pointer;padding:0;letter-spacing:.05em}

  /* Topbar — always visible (both desktop and mobile), same as Ops: page
     title + the account-level controls (company switcher, role badge,
     refresh, sign out) that live redundantly here as well as in the
     desktop sidebar, so they're still reachable once the sidebar hides on
     mobile. */
  .topbar{display:flex;flex-wrap:wrap;background:${colors.panel};border-bottom:1px solid ${colors.border};padding:14px 20px;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10;gap:12px}
  .page-title{font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:600;color:${colors.cream};letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .topbar-select{background:rgba(0,0,0,.25);border:1px solid ${colors.border};border-radius:6px;padding:5px 8px;color:${colors.cream};font-family:'Inter',sans-serif;font-size:12px}
  .topbar-select option{background:${colors.panel}}
  .topbar-signout{background:none;border:1px solid ${colors.border};border-radius:6px;color:${colors.muted};font-size:11px;font-weight:600;cursor:pointer;padding:5px 10px;flex-shrink:0}

  /* Mobile-only location + period strip — sidebar already covers these on
     desktop, so this only needs to render <=768px. */
  .mobile-loc-bar{display:none}
  @media (max-width: 768px) {
    .mobile-loc-bar{
      display:flex;gap:6px;align-items:center;padding:8px 14px;
      background:${colors.panel};border-bottom:1px solid ${colors.border};
      overflow-x:auto;-webkit-overflow-scrolling:touch;
    }
    .mobile-loc-btn{
      flex-shrink:0;padding:5px 12px;border-radius:20px;border:1px solid transparent;
      font-family:'Inter',sans-serif;font-size:11px;font-weight:600;cursor:pointer;
      background:transparent;color:${colors.muted};display:flex;align-items:center;gap:5px;
      white-space:nowrap;
    }
    .mobile-loc-btn.active-ZC{background:rgba(184,147,90,.18);border-color:rgba(184,147,90,.5);color:${colors.gold}}
    .mobile-loc-btn.active-EC{background:rgba(91,140,196,.18);border-color:rgba(91,140,196,.5);color:${colors.loc.EC}}
    .mobile-loc-btn.active-SC{background:rgba(123,174,127,.18);border-color:rgba(123,174,127,.5);color:${colors.loc.SC}}
    .mobile-period-input{margin-left:auto;flex-shrink:0}
  }

  @media (max-width: 768px) {
    .sidebar{display:none}
    .bottom-nav{
      display:flex;position:fixed;bottom:0;left:0;right:0;
      background:${colors.panel};border-top:1px solid ${colors.border};
      z-index:10;padding:8px;padding-bottom:calc(8px + env(safe-area-inset-bottom));
      box-sizing:border-box;
    }
    .main{padding-bottom:70px}
  }
`
