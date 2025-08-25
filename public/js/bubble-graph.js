// public/js/bubble-graph.js
(() => {
  // Public API
  window.initBubbleGraph = initBubbleGraph;

  // ====== Config
  const COLORS = {
    text: 'var(--text)',
    panel: 'var(--panel)',
    muted: 'var(--muted)',
    creator: '#ffd166',
    lp: '#c586ff',
    burn: '#94a3b8',
    proxy: '#5aa7ff',
    funder: '#07c160',
    normal: '#e8fff3',
    fundingEdge: '#07c160',
    connEdge: '#89b6a0'
  };

  // Seeded proxy map (you can augment dynamically at runtime)
  const KNOWN_PROXIES = new Map([
    ['0x1c4ae91dfa56e49fca849ede553759e1f5f04d9f', { name: 'TG Proxy', type: 'telegram-bot' }]
  ]);

  const R_MIN = 8, R_MAX = 56;
  const EDGE_ALPHA = 0.22, EDGE_ALPHA_HI = 0.9;

  const short = a => (a && a.length > 10) ? (a.slice(0,6) + '…' + a.slice(-4)) : (a || '');
  const fmtPct = x => Number.isFinite(x) ? ((x >= 1) ? x.toFixed(2) : (x >= 0.1) ? x.toFixed(2) : x.toFixed(3)) + '%' : '-';
  const fmtNum = x => (x == null) ? '-' : (Math.abs(x) >= 1e6 ? (x/1e6).toFixed(2)+'M' : Math.abs(x) >= 1e3 ? (x/1e3).toFixed(2)+'k' : String(x));

  function roleColor(tags = []) {
    const set = new Set(tags.map(t => String(t).toLowerCase()));
    if (set.has('creator')) return COLORS.creator;
    if (set.has('lp')) return COLORS.lp;
    if (set.has('burn')) return COLORS.burn;
    if (set.has('proxy') || set.has('bot')) return COLORS.proxy;
    if (set.has('funder') || set.has('cluster')) return COLORS.funder;
    return COLORS.normal;
  }

  function mkRadiusScale(nodes) {
    const maxPct = Math.max(0.0001, d3.max(nodes, d => +d.pct || 0));
    return d3.scaleSqrt().domain([0, maxPct]).range([R_MIN, R_MAX]);
  }

  function buildNeighbors(nodes, edges) {
    const idx = new Map(nodes.map(n => [n.address.toLowerCase(), true]));
    const nbrs = new Map();
    const touch = (a,b) => {
      a = a.toLowerCase(); b = b.toLowerCase();
      if (!nbrs.has(a)) nbrs.set(a, new Set());
      if (!nbrs.has(b)) nbrs.set(b, new Set());
      nbrs.get(a).add(b);
      nbrs.get(b).add(a);
    };
    edges.forEach(e => {
      if (!e.source || !e.target) return;
      if (!idx.has(e.source.toLowerCase()) || !idx.has(e.target.toLowerCase())) return;
      touch(e.source, e.target);
    });
    return nbrs;
  }

  function tagProxy(node) {
    const px = node.viaProxy?.proxyAddress?.toLowerCase();
    if (!px) return;
    node.tags = node.tags || [];
    if (!node.tags.includes('proxy')) node.tags.push('proxy');
    if (node.viaProxy.botName || node.viaProxy.type === 'telegram-bot') {
      if (!node.tags.includes('bot')) node.tags.push('bot');
    }
  }

  // ====== Main
  function initBubbleGraph(container, data, opts = {}) {
    const el = (typeof container === 'string') ? document.querySelector(container) : container;
    if (!el) throw new Error('initBubbleGraph: container not found');

    const explorer = data.meta?.explorer || 'https://abscan.org';
    // Allow adding proxies later
    (data.meta?.knownProxies || []).forEach(p => {
      if (p?.address) KNOWN_PROXIES.set(String(p.address).toLowerCase(), { name: p.name||'Proxy', type: p.type||'proxy' });
    });

    // Preprocess nodes
    const holders = (data.holders || []).map(h => {
      const n = {
        id: h.address,
        address: h.address,
        label: h.label ?? null,
        tags: (h.tags || []).slice(),
        pct: +h.pct || 0,
        balance: h.balance,         // current token balance (raw or decimalized; you decide upstream)
        initialBuy: h.initialBuy,   // amount first acquired (same unit as balance)
        stillHeldPct: null,         // computed below
        viaProxy: h.viaProxy || null,
        fundedBy: (h.fundedBy || []).slice(0, 10),
        connections: (h.connections || []).slice(0, 20),
        firstBuy: h.firstBuy || null
      };
      // compute "still held from initial buy" percent (clamped 0..100)
      if (n.initialBuy != null && n.initialBuy > 0 && n.balance != null) {
        const pct = Math.max(0, Math.min(100, (Number(n.balance) / Number(n.initialBuy)) * 100));
        n.stillHeldPct = pct;
      }
      // Proxy tagging (from node.viaProxy or known proxies list)
      if (!n.viaProxy && KNOWN_PROXIES.has(n.address?.toLowerCase())) {
        const meta = KNOWN_PROXIES.get(n.address.toLowerCase());
        n.viaProxy = { proxyAddress: n.address, type: meta.type, botName: meta.name };
      }
      if (n.viaProxy?.proxyAddress) tagProxy(n);
      return n;
    });

    // Ensure creator/lp/burn nodes are tagged if present
    const addTag = (addr, t) => {
      if (!addr) return;
      const a = String(addr).toLowerCase();
      const n = holders.find(x => x.address?.toLowerCase() === a);
      if (n) { n.tags = n.tags || []; if (!n.tags.includes(t)) n.tags.push(t); }
    };
    addTag(data.meta?.creator, 'creator');
    addTag(data.meta?.lp, 'lp');
    addTag(data.meta?.burn, 'burn');

    // edges can include funding + "conn" (connected wallets)
    const edges = (data.edges || []).filter(e => e.source && e.target).map(e => ({
      source: e.source, target: e.target, type: e.type || 'conn', weight: e.weight || 1
    }));

    // Build neighbors
    const neighbors = buildNeighbors(holders, edges);

    // Layout container
    el.innerHTML = '';
    el.classList.add('panel', 'mono');

    const topBar = document.createElement('div');
    topBar.style.display = 'flex';
    topBar.style.gap = '8px';
    topBar.style.alignItems = 'center';
    topBar.style.marginBottom = '8px';

    const search = document.createElement('input');
    search.placeholder = 'Search address / tag / label';
    Object.assign(search.style, {
      flex: '1', background: 'var(--panel)', color: 'var(--text)',
      border: '1px solid var(--muted)', padding: '6px 8px', borderRadius: '6px'
    });

    const chkFunding = mkToggle('Funding links (≤120m)', true);
    const chkConn = mkToggle('Connections', true);
    const btnReset = mkBtn('Reset view');

    topBar.append(search, chkFunding, chkConn, btnReset);
    el.appendChild(topBar);

    // Legend
    const legend = document.createElement('div');
    legend.style.fontSize = '12px';
    legend.style.margin = '4px 0 8px';
    legend.innerHTML = [
      lg('Creator', COLORS.creator),
      lg('LP', COLORS.lp),
      lg('Burn', COLORS.burn),
      lg('Proxy/Bot', COLORS.proxy),
      lg('Funder/Cluster', COLORS.funder),
      lg('Normal', COLORS.normal),
      `<span style="opacity:.85">Edges: <span style="color:${COLORS.fundingEdge}">fund</span>/<span style="color:${COLORS.connEdge}">conn</span></span>`
    ].join(' ');
    el.appendChild(legend);

    // Drawing surface
    const wrap = document.createElement('div');
    wrap.style.position = 'relative';
    wrap.style.width = '100%';
    wrap.style.height = '560px';
    el.appendChild(wrap);

    // Info card (fixed)
    const info = document.createElement('div');
    Object.assign(info.style, {
      position: 'absolute', right: '10px', bottom: '10px',
      minWidth: '260px', maxWidth: '320px', background: 'rgba(15,42,32,.92)',
      border: '1px solid var(--muted)', borderRadius: '8px',
      padding: '10px', fontSize: '12px', pointerEvents: 'none', display: 'none'
    });
    wrap.appendChild(info);

    // SVG
    const { width, height } = wrap.getBoundingClientRect();
    const svg = d3.select(wrap).append('svg').attr('width', width).attr('height', height).style('cursor', 'grab');

    const rootG = svg.append('g');
    const linkG = rootG.append('g').attr('class', 'links');
    const nodeG = rootG.append('g').attr('class', 'nodes');

    // Zoom & pan
    const zoom = d3.zoom().scaleExtent([0.6, 7]).on('zoom', (ev) => rootG.attr('transform', ev.transform));
    svg.call(zoom);
    btnReset.onclick = () => svg.transition().duration(450).call(zoom.transform, d3.zoomIdentity);

    // Initial positions using d3.pack for neat non-overlap
    const radius = mkRadiusScale(holders);
    holders.forEach(n => n.r = radius(n.pct));
    const pack = d3.pack().size([width, height]).padding(3);
    const root = d3.hierarchy({ children: holders }).sum(d => (d && d.r ? d.r*d.r : 1));
    const packed = pack(root).leaves();
    const id2pos = new Map(packed.map(p => [p.data.address.toLowerCase(), p]));
    holders.forEach(n => {
      const p = id2pos.get(n.address.toLowerCase());
      n.x = p ? p.x : Math.random() * width;
      n.y = p ? p.y : Math.random() * height;
    });

    // Gentle “space drift” to make it feel alive (without ruining layout)
    // Adds a tiny force jitter around the packed positions
    const sim = d3.forceSimulation(holders)
      .alphaDecay(0.02)
      .velocityDecay(0.4)
      .force('x', d3.forceX(d => d.x).strength(0.02))
      .force('y', d3.forceY(d => d.y).strength(0.02))
      .force('collide', d3.forceCollide(d => Math.max(6, d.r)).strength(0.7))
      .on('tick', () => {
        nodeSel.attr('transform', d => `translate(${d.x},${d.y})`);
        linkSel
          .attr('x1', d => addrNode(d.source)?.x || 0).attr('y1', d => addrNode(d.source)?.y || 0)
          .attr('x2', d => addrNode(d.target)?.x || 0).attr('y2', d => addrNode(d.target)?.y || 0);
      });

    // Render links
    const linkSel = linkG.selectAll('line').data(edges, d => `${d.source}|${d.target}|${d.type}`).join('line')
      .attr('stroke', d => d.type === 'funding' ? COLORS.fundingEdge : COLORS.connEdge)
      .attr('stroke-opacity', EDGE_ALPHA)
      .attr('stroke-width', d => Math.max(1, d.weight || 1));

    // Render nodes
    const nodeSel = nodeG.selectAll('g.node').data(holders, d => d.address).join(enter => {
      const g = enter.append('g').attr('class', 'node').attr('transform', d => `translate(${d.x},${d.y})`).style('cursor', 'pointer');

      g.append('circle')
        .attr('r', d => Math.max(R_MIN, d.r || R_MIN))
        .attr('fill', d => roleColor(d.tags))
        .attr('fill-opacity', 0.95)
        .attr('stroke', 'rgba(0,0,0,.35)')
        .attr('stroke-width', 1);

      // status bar (how much of initial buy still held) — draw as a small arc ring
      const arc = d3.arc().innerRadius(d => Math.max(4, (d.r||R_MIN) * 0.72)).outerRadius(d => Math.max(5, (d.r||R_MIN) * 0.86));
      g.append('path')
        .attr('class', 'held-ring-bg')
        .attr('d', d => arc({ startAngle: 0, endAngle: 2 * Math.PI }))
        .attr('fill', 'rgba(0,0,0,.15)');

      g.append('path')
        .attr('class', 'held-ring')
        .attr('d', d => arc({ startAngle: 0, endAngle: (d.stillHeldPct != null ? (d.stillHeldPct / 100) : 0) * 2 * Math.PI }))
        .attr('fill', COLORS.funder);

      // label
      g.append('text')
        .text(d => d.label || short(d.address))
        .attr('text-anchor', 'middle')
        .attr('dy', '0.32em')
        .attr('font-size', d => Math.max(9, Math.min(12, (d.r||R_MIN)/3 + 7)))
        .attr('pointer-events', 'none')
        .attr('fill', 'rgba(0,0,0,.85)');

      return g;
    });

    // Edge toggles
    function applyEdgeVisibility() {
      linkSel.attr('display', d => {
        if (d.type === 'funding' && !chkFunding.input.checked) return 'none';
        if (d.type !== 'funding' && !chkConn.input.checked) return 'none';
        return null;
      });
    }
    chkFunding.input.onchange = applyEdgeVisibility;
    chkConn.input.onchange = applyEdgeVisibility;
    applyEdgeVisibility();

    // Hover & click interactions
    const nb = new Map(holders.map(n => [n.address.toLowerCase(), n]));
    function addrNode(a){ return nb.get(String(a).toLowerCase()); }

    nodeSel.on('mouseenter', (ev, d) => {
      showInfo(info, d, explorer);
      highlight(d, true);
    }).on('mouseleave', (ev, d) => {
      info.style.display = 'none';
      highlight(d, false);
    }).on('click', (ev, d) => {
      // center + zoom in a touch
      const t = d3.zoomTransform(svg.node());
      const k = Math.max(1.5, t.k);
      const tx = width/2 - d.x * k;
      const ty = height/2 - d.y * k;
      svg.transition().duration(450).call(zoom.transform, d3.zoomIdentity.translate(tx,ty).scale(k));
      info.style.display = 'block';
      info.style.pointerEvents = 'auto';
    });

    function highlight(node, on) {
      const neigh = neighbors.get(node.address.toLowerCase()) || new Set();
      nodeG.selectAll('g.node').select('circle')
        .attr('fill-opacity', d => {
          if (!on) return 0.95;
          if (d.address.toLowerCase() === node.address.toLowerCase()) return 1;
          return neigh.has(d.address.toLowerCase()) ? 1 : 0.15;
        });

      nodeG.selectAll('g.node').select('text')
        .attr('opacity', d => {
          if (!on) return 1;
          if (d.address.toLowerCase() === node.address.toLowerCase()) return 1;
          return neigh.has(d.address.toLowerCase()) ? 1 : 0.2;
        });

      linkSel.attr('stroke-opacity', d => {
        if (!on) return ((d.type==='funding' && chkFunding.input.checked) || (d.type!=='funding' && chkConn.input.checked)) ? EDGE_ALPHA : 0;
        const touches = d.source.toLowerCase() === node.address.toLowerCase() || d.target.toLowerCase() === node.address.toLowerCase();
        return touches ? EDGE_ALPHA_HI : 0.06;
      });
    }

    // Search
    search.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const q = (search.value || '').trim().toLowerCase();
      if (!q) return;
      const target =
        holders.find(n => n.address.toLowerCase() === q) ||
        holders.find(n => (n.label||'').toLowerCase() === q) ||
        holders.find(n => (n.tags||[]).some(t => String(t).toLowerCase() === q)) ||
        holders.find(n => short(n.address).toLowerCase() === q);
      if (target) {
        const k = 2.2;
        const tx = width/2 - target.x * k;
        const ty = height/2 - target.y * k;
        svg.transition().duration(450).call(zoom.transform, d3.zoomIdentity.translate(tx,ty).scale(k));
        showInfo(info, target, explorer);
        highlight(target, true);
        setTimeout(() => highlight(target, false), 2000);
      }
    });

    // Resize
    const ro = new ResizeObserver(() => {
      const { width: w2, height: h2 } = wrap.getBoundingClientRect();
      svg.attr('width', w2).attr('height', h2);
    });
    ro.observe(wrap);

    // Helpers
    function showInfo(panel, node, ex) {
      const still = (node.stillHeldPct != null) ? node.stillHeldPct.toFixed(1) + '%' : '–';
      const tagsLine = node.tags?.length ? `<div><b>Tags:</b> ${node.tags.join(', ')}</div>` : '';
      const proxyLine = node.viaProxy?.proxyAddress
        ? `<div><b>Proxy:</b> <a href="${ex}/address/${node.viaProxy.proxyAddress}" target="_blank">${short(node.viaProxy.proxyAddress)}</a> <span class="tag mono">${node.viaProxy.botName || node.viaProxy.type || ''}</span></div>`
        : '';
      const funders = (node.fundedBy||[]).slice(0,6).map(a => `<a href="${ex}/address/${a}" target="_blank">${short(a)}</a>`).join(', ');
      const conns = (node.connections||[]).slice(0,8).map(a => `<a href="${ex}/address/${a}" target="_blank">${short(a)}</a>`).join(', ');
      const buy = node.firstBuy ? `<div><b>First Buy:</b> <a href="${ex}/tx/${node.firstBuy}" target="_blank">${short(node.firstBuy)}</a></div>` : '';
      const heldBar = `
        <div style="margin-top:6px">
          <div style="display:flex;justify-content:space-between"><span>Still held from initial buy</span><b>${still}</b></div>
          <div style="height:8px;background:rgba(0,0,0,.18);border-radius:4px;overflow:hidden;margin-top:4px">
            <div style="height:100%;width:${node.stillHeldPct?Math.max(0,Math.min(100,node.stillHeldPct)):0}%;background:${COLORS.funder}"></div>
          </div>
        </div>`;

      panel.innerHTML = `
        <div style="margin-bottom:6px;"><b>${node.label || short(node.address)}</b></div>
        <div><b>Address:</b> <a href="${ex}/address/${node.address}" target="_blank">${node.address}</a></div>
        <div><b>Holdings:</b> ${fmtPct(node.pct)} of supply</div>
        ${buy}
        ${proxyLine}
        ${tagsLine}
        ${node.fundedBy?.length ? `<div><b>Funded by:</b> ${funders}</div>` : ''}
        ${node.connections?.length ? `<div><b>Connections:</b> ${conns}</div>` : ''}
        ${heldBar}
      `;
      panel.style.display = 'block';
    }

    function mkToggle(label, init = true) {
      const wrap = document.createElement('label');
      wrap.style.display = 'inline-flex';
      wrap.style.alignItems = 'center';
      wrap.style.gap = '6px';
      const input = document.createElement('input');
      input.type = 'checkbox'; input.checked = !!init;
      const span = document.createElement('span'); span.textContent = label;
      wrap.append(input, span); wrap.input = input; return wrap;
    }
    function mkBtn(label) {
      const b = document.createElement('button');
      b.textContent = label; b.className = 'btn';
      Object.assign(b.style, { border:'1px solid var(--muted)', background:'var(--panel)', color:'var(--text)', padding:'6px 10px', borderRadius:'6px' });
      return b;
    }
    function lg(name, color) {
      return `<span style="display:inline-flex;align-items:center;gap:6px;margin-right:10px"><span style="width:10px;height:10px;border-radius:50%;background:${color};display:inline-block"></span>${name}</span>`;
    }
  }
})();
