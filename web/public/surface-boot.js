/*
 * Surface detection, before first paint.
 *
 * Deliberately an external file rather than an inline <script>. The CSP in
 * staticwebapp.config.json is `default-src 'self'` with no script-src, so an
 * inline script is blocked in production — and the failure is silent: no error
 * anyone sees, just a wall tablet quietly rendering the phone layout forever.
 * Served from /public, so it is never bundled or hashed and the path stays
 * stable.
 *
 * Priority: an explicit ?kiosk= flag (persisted to localStorage), then the
 * device-shape heuristic. The enrolled kiosk device token, once fetched,
 * overrides both — see src/lib/surface.ts.
 *
 * ES5 only. This runs before anything else on devices whose engine we do not
 * control, and it must never be the thing that throws.
 */
(function () {
  try {
    var params = new URLSearchParams(location.search);
    if (params.has('kiosk')) {
      localStorage.setItem('fd.kiosk', params.get('kiosk') === '0' ? '0' : '1');
    }
    var forced = localStorage.getItem('fd.kiosk');
    var isKiosk =
      forced === '1' ||
      (forced !== '0' &&
        window.matchMedia(
          '(min-width: 1024px) and (pointer: coarse) and (orientation: landscape)'
        ).matches);
    document.documentElement.setAttribute('data-surface', isKiosk ? 'kiosk' : 'compact');
  } catch (e) {
    document.documentElement.setAttribute('data-surface', 'compact');
  }
})();
