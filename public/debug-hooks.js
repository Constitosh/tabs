/*! debug-hooks v1 — non-invasive logging to find why single-token view is blank */
(function(){
  const log = (...a)=>console.log('[debug-hooks]', ...a);
  const warn = (...a)=>console.warn('[debug-hooks]', ...a);
  const err = (...a)=>console.error('[debug-hooks]', ...a);

  log('loaded');

  // Global error catchers (surface silent failures)
  window.addEventListener('error', (e)=>{
    err('window.error', e.message, e.filename+':'+e.lineno+':'+e.colno, e.error);
  });
  window.addEventListener('unhandledrejection', (e)=>{
    err('unhandledrejection', e.reason);
  });

  // Trace fetch to /api endpoints
  const _fetch = window.fetch;
  window.fetch = function(){
    try {
      const url = arguments[0];
      const opts = arguments[1]||{};
      if (typeof url === 'string' && url.startsWith('/api/')){
        log('fetch →', url, opts && opts.method || 'GET', opts && opts.body || '');
      }
    } catch(e){}
    return _fetch.apply(this, arguments).then(r=>{
      try {
        const u = arguments[0];
        if (typeof u === 'string' && u.startsWith('/api/')){
          log('fetch ✓', u, r.status);
        }
      } catch(e){}
      return r;
    }).catch(e=>{
      err('fetch ✗', arguments[0], e);
      throw e;
    });
  };

  // Log when user clicks a token-ish element
  document.addEventListener('click', (e)=>{
    const t = e.target.closest('[data-ca],[data-token],[data-address],a,img,button');
    if (!t) return;
    const ca = t.getAttribute('data-ca') || t.getAttribute('data-token') || t.getAttribute('data-address');
    if (ca) log('click token candidate', { tag:t.tagName, ca });
  });

  // If your app exposes these, log when they are called (no behavior change)
  function wrapIf(name){
    const g = window[name];
    if (typeof g === 'function'){
      window[name] = function(){
        log(name+'()', Array.from(arguments));
        return g.apply(this, arguments);
      };
      log('wrapped', name);
    } else {
      warn('function not found:', name);
    }
  }

  // Common names in your codebase (safe if missing)
  ['onAddTokenSubmit','renderSingle','drawBubbles'].forEach(wrapIf);

  // When bubbles appear, log how many nodes we see
  const mo = new MutationObserver(()=>{
    const root = document.getElementById('bubble-canvas');
    if (!root) return;
    const nodes = root.querySelectorAll('[data-address], [data-addr], circle, [role="bubble"]');
    if (nodes.length) log('bubble nodes present:', nodes.length);
  });
  mo.observe(document.documentElement, { childList:true, subtree:true });
})();
