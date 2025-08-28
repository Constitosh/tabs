/*! add-token-bridge v1 — drives single-token render after /api/add-token
 *  - Non-invasive: wraps fetch; won’t break existing logic.
 *  - On 200 JSON from /api/add-token, calls renderSingle(ca, row) if available.
 *  - Else, dispatches an event so extensions can listen without errors.
 */
(function(){
  const log = (...a)=>console.log('[add-token-bridge]', ...a);
  const warn = (...a)=>console.warn('[add-token-bridge]', ...a);
  const err = (...a)=>console.error('[add-token-bridge]', ...a);

  // Wrap renderSingle to log calls & catch runtime errors (helps if it throws)
  if (typeof window.renderSingle === 'function') {
    const _renderSingle = window.renderSingle;
    window.renderSingle = async function(){
      try {
        log('renderSingle()', arguments);
        return await _renderSingle.apply(this, arguments);
      } catch (e) {
        err('renderSingle error:', e);
        throw e;
      }
    };
    log('wrapped renderSingle');
  } else {
    warn('renderSingle not found at load; will still try later if available.');
  }

  const _fetch = window.fetch;
  window.fetch = async function(input, init){
    const res = await _fetch.apply(this, arguments);
    try {
      // Extract URL reliably from Request/string
      const url = (typeof input === 'string') ? input : (input && input.url) || '';
      if (url.includes('/api/add-token')) {
        const clone = res.clone();
        let data = null;
        try { data = await clone.json(); } catch { /* not JSON */ }
        log('/api/add-token response', { status: res.status, ok: res.ok, data });

        if (res.ok && data && data.row) {
          const ca = data.row.baseAddress
                 || (data.row.baseToken && data.row.baseToken.address)
                 || data.row.address
                 || '';
          if (/^0x[0-9a-fA-F]{40}$/.test(ca)) {
            // Keep for other scripts/tools
            window.__currentTokenRow = data.row;

            if (typeof window.renderSingle === 'function') {
              try {
                await window.renderSingle(ca, data.row);
                log('renderSingle invoked by bridge for', ca);
              } catch (e) {
                err('renderSingle threw:', e);
              }
            } else {
              // Fire a safe event so other code can react
              document.body.dispatchEvent(
                new CustomEvent('tabs:goSingle', { detail: { ca, row: data.row } })
              );
              warn('renderSingle missing — dispatched tabs:goSingle');
            }
          } else {
            warn('Could not find a valid CA in /api/add-token payload.');
          }
        }
      }
    } catch (e) {
      warn('add-token-bridge parse/log error:', e);
    }
    return res;
  };

  log('loaded');
})();
