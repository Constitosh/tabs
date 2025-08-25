// public/js/bubble-graph.js
(() => {
  window.initBubbleGraph = initBubbleGraph;

  const COLORS = {
    text: 'var(--text)',
    panel: 'var(--panel)',
    muted: 'var(--muted)',
    creator: '#ffd166',
    lp: '#c586ff',
    burn: '#94a3b8',
    proxy: '#ffd54a',             // yellow ring emphasis
    funder: '#07c160',
    normal: '#e8fff3',
    fundingEdge: '#07c160',
    connEdge: '#89b6a0'
  };

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
    if (set.has('funder') || set.has('cluster')) return COLORS.funder;
    return COLORS.normal;
  }

  function mkRadiusScale(nodes) {
    const maxPct = Math.max(0.0001, ...nodes.map(d => +d.pct || 0));
    return d3.scaleSqrt().domain([0, maxPct]).range([R_MIN, R_MAX]);
  }

  function buildNeighbors(nodes, edges) {
    const idx = new Set(nodes.map(n => n.address.toLowerCase()));
    const nbrs = new Map();
    const touch = (a,b) => {
      a = a.toLowerCase(); b = b.toLowerCase();
      if (!nbrs.has(a)) nbrs.set(a, new Set());
      if (!nbrs.has(b)) nbrs.set(b, new Set());
      nbrs.get(a).add(b);
      nbrs.get(b).add(a);
    };
    (edges||[]).forEach(e => {
      if (!e.source || !e.target) return;
      if (!idx.has(e.source.toLowerCase()) || !idx.has(e.target.toLowerCase())) return;
      touch(e.source, e.target);
    });
    return nbrs;
  }

  function initBubbleGraph(container, data, opts = {}) {
    const el = (typeof container === 'string') ? document.querySelector(container) : container;
    if (!el) throw new Error('initBubbleGraph: container not found');

    const explorer = data.meta?.explorer || 'https://abscan.org';

    // cap to max 500 just in case (scan already does this)
    const nodesRaw = (data.holders || []).slice(0, 500).map(h => ({
      id: h.address,
      address: h.address,
      label: h.label ?? null,
      tags: (h.tags || []).slice(),
      pct: +h.pct || 0,
      balance: h.balance,
      // extra stats if present:
      peak: h.peak ?? null,                    // peak token amount ever held (same unit as balance)
      pctLeft: h.pctLeft ?? null,              // percent of peak still held
      viaProxy: h.viaProxy || null,
      fundedBy: h.fundedBy || [],
      connections: h.connections || [],
      firstBuy: h.firstBuy || null
    }));

    // Tag creator/lp/burn
    const addTag = (addr, t) => {
      if (!addr) return;
      const a = String(addr).toLowerCase();
      const n = nodesRaw.find(x => x.address?.toLowerCase() === a);
      if (n) { n.tags = n.tags || []; if (!n.tags.includes(t)) n.tags.push(t); if (t==='lp' && !n.label) n.label='LP'; if (t==='creator' && !n.label) n.label='CREATOR'; }
    };
    addTag(data.meta?.creator, 'creator');
    addTag(data.meta?.lp, 'lp');

    const edges = (data.edges || []).filter(e => e.source && e.target).map(e => ({
      source: e.source, target: e.target, type: e.type || 'conn', weight: e.weight || 1
    }));

    const neighbors = buildNeighbors(nodesRaw, edges);

    // Layout
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

    const chkFunding = mkToggle('Funding links', true);
    const chkConn = mkToggle('Connections', true);
    const btnReset = mkBtn('Reset view');

    topBar.append(search, chkFunding, chkConn, btnReset);
    el.appendChild(topBar);

    const wrap = document.createElement('div');
    wrap.style.position = 'relative';
    wrap.style.width = '100%';
    wrap.style.height = '560px';
    el.appendChild(wrap);

    const info = document.createElement('div');
    Object.assign(info.style, {
      position: 'absolute', right: '10px', bottom: '10px',
      minWidth: '260px', maxWidth: '320px', background: 'rgba(15,42,32,.92)',
      border: '1px solid var(--muted)', borderRadius: '8px',
      padding: '10px', fontSize: '12px', pointerEvents: 'none', display: 'none'
    });
    wrap.appendChild(info);

    const { width, height } = wrap.getBoundingClientRect();
    const svg = d3.select(wrap).append('svg').attr('width', width).attr('height', height).style('cursor', 'grab');
    const rootG = svg.append('g');
    const linkG = rootG.append('g').attr('class', 'links');
    const nodeG = rootG.append('g').attr('class', 'nodes');

    const zoom = d3.zoom().scaleExtent([0.6, 7]).on('zoom', (ev) => rootG.attr('transform', ev.transform));
    svg.call(zoom);
    btnReset.onclick = () => svg.transition().duration(450).call(zoom.transform, d3.zoomIdentity);

    // pack positions
    const radius = mkRadiusScale(nodesRaw);
    nodesRaw.forEach(n => n.r = radius(n.pct));
    const pack = d3.pack().size([width, height]).padding(3);
    const root = d3.hierarchy({ children: nodesRaw }).sum(d => (d && d.r ? d.r*d.r : 1));
    const packed = pack(root).leaves();
    const id2pos = new Map(packed.map(p => [p.data.address.toLowerCase(), p]));
    nodesRaw.forEach(n => {
      const p = id2pos.get(n.address.toLowerCase());
      n.x = p ? p.x : Math.random() * width;
      n.y = p ? p.y : Math.random() * height;
    });

    // drift sim (pause on first user zoom/pan)
    const sim = d3.forceSimulation(nodesRaw)
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

    svg.on('mousedown.zoomstop', () => { sim.alphaTarget(0).stop(); });

    // edges
    const linkSel = linkG.selectAll('line').data(edges, d => `${d.source}|${d.target}|${d.type}`).join('line')
      .attr('stroke', d => d.type === 'funding' ? COLORS.fundingEdge : COLORS.connEdge)
      .attr('stroke-opacity', EDGE_ALPHA)
      .attr('stroke-width', d => Math.max(1, d.weight || 1));

    // nodes
    const nodeSel = nodeG.selectAll('g.node').data(nodesRaw, d => d.address).join(enter => {
      const g = enter.append('g').attr('class', 'node').attr('transform', d => `translate(${d.x},${d.y})`).style('cursor','pointer');

      // main bubble
      g.append('circle')
        .attr('r', d => Math.max(R_MIN, d.r || R_MIN))
        .attr('fill', d => roleColor(d.tags))
        .attr('fill-opacity', 0.95)
        .attr('stroke', 'rgba(0,0,0,.35)')
        .attr('stroke-width', 1);

      // proxy/bot ring (always visible if tagged)
      g.append('circle')
        .attr('class', 'proxy-ring')
        .attr('r', d => Math.max(R_MIN, d.r || R_MIN) + 2)
        .attr('fill', 'none')
        .attr('stroke', d => (d.tags||[]).some(t=>String(t).toLowerCase()==='proxy' || String(t).toLowerCase()==='bot') ? COLORS.proxy : 'none')
        .attr('stroke-width', 2);

      // label: % of supply
      g.append('text')
        .text(d => `${(+d.pct || 0).toFixed(2)}%`)
        .attr('text-anchor', 'middle')
        .attr('dy', '0.32em')
        .attr('font-size', d => Math.max(9, Math.min(12, (d.r||R_MIN)/3 + 7)))
        .attr('pointer-events', 'none')
        .attr('fill', 'rgba(0,0,0,.85)');

      return g;
    });

    // “fit to view” once after initial draw
    fitToView();

    function fitToView(){
      const bbox = nodeG.node().getBBox();
      const pad = 30;
      const scale = Math.min(
        (width  - pad*2) / Math.max(1, bbox.width),
        (height - pad*2) / Math.max(1, bbox.height)
      );
      const k = Math.max(0.6, Math.min(3, scale));
      const tx = (width  - k*(bbox.x + bbox.width/2));
      const ty = (height - k*(bbox.y + bbox.height/2));
      svg.transition().duration(450).call(zoom.transform, d3.zoomIdentity.translate(tx,ty).scale(k));
    }

    // interactions
    const nb = new Map(nodesRaw.map(n => [n.address.toLowerCase(), n]));
    function addrNode(a){ return nb.get(String(a).toLowerCase()); }

    nodeSel.on('mouseenter', (ev, d) => {
      showInfo(info, d, explorer);
      highlight(d, true);
    }).on('mouseleave', (ev, d) => {
      info.style.display = 'none';
      highlight(d, false);
    }).on('click', (ev, d) => {
      window.open(`${explorer}/address/${d.address}`, '_blank');
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

    // search
    search.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const q = (search.value || '').trim().toLowerCase();
      if (!q) return;
      const target =
        nodesRaw.find(n => n.address.toLowerCase() === q) ||
        nodesRaw.find(n => (n.label||'').toLowerCase() === q) ||
        nodesRaw.find(n => (n.tags||[]).some(t => String(t).toLowerCase() === q)) ||
        nodesRaw.find(n => short(n.address).toLowerCase() === q);
      if (target) {
        showInfo(info, target, explorer);
        highlight(target, true);
        setTimeout(() => highlight(target, false), 1600);
      }
    });

    const ro = new ResizeObserver(() => {
      const { width: w2, height: h2 } = wrap.getBoundingClientRect();
      svg.attr('width', w2).attr('height', h2);
    });
    ro.observe(wrap);

    function showInfo(panel, node, ex) {
      const tagsLine = node.tags?.length ? `<div><b>Tags:</b> ${node.tags.join(', ')}</div>` : '';
      const peakLine = (node.peak != null)
        ? `<div><b>Peak held:</b> ${fmtNum(node.peak)} — <b>Left:</b> ${node.pctLeft != null ? node.pctLeft.toFixed(1)+'%' : '—'}</div>`
        : '';
      const funders = (node.fundedBy||[]).slice(0,6).map(a => `<a href="${ex}/address/${a}" target="_blank">${short(a)}</a>`).join(', ');
      const conns = (node.connections||[]).slice(0,8).map(a => `<a href="${ex}/address/${a}" target="_blank">${short(a)}</a>`).join(', ');
      const buy = node.firstBuy ? `<div><b>First Buy:</b> <a href="${ex}/tx/${node.firstBuy}" target="_blank">${short(node.firstBuy)}</a></div>` : '';

      panel.innerHTML = `
        <div style="margin-bottom:6px;"><b>${node.label || `${(+node.pct||0).toFixed(2)}%`}</b></div>
        <div><b>Address:</b> <a href="${ex}/address/${node.address}" target="_blank">${node.address}</a></div>
        <div><b>Holdings:</b> ${fmtPct(node.pct)} of supply</div>
        ${buy}
        ${tagsLine}
        ${peakLine}
        ${node.fundedBy?.length ? `<div><b>Funded by:</b> ${funders}</div>` : ''}
        ${node.connections?.length ? `<div><b>Connections:</b> ${conns}</div>` : ''}
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
  }
})();
