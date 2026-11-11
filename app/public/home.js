const REFRESH_MS = 3000;

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function statusChip(demo) {
  if (demo.phase === 'ready') return `<span class="status-chip ready">● Ready · ${esc(demo.step)}</span>`;
  if (demo.phase === 'failed') return '<span class="status-chip failed">Setup failed</span>';
  return '<span class="status-chip">Preparing…</span>';
}

function render(demos) {
  document.getElementById('demo-cards').innerHTML = demos.map((demo) => `
    <a class="demo-card" href="/${encodeURIComponent(demo.id)}">
      <div class="demo-card-head"><h2>${esc(demo.title)}</h2>${statusChip(demo)}</div>
      <p>${esc(demo.summary)}</p>
      <ol class="flow">${demo.flow.map((step) => `<li data-focus="${esc(step.focus ?? 'none')}">${esc(step.short)}</li>`).join('')}</ol>
      <span class="btn btn-primary open">Open →</span>
    </a>`).join('');
}

async function refresh() {
  try {
    const response = await fetch('/api/demos', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
  } catch (error) {
    document.getElementById('demo-cards').innerHTML = `<p class="setup-error">Could not load the demos: ${esc(error.message)}</p>`;
  } finally {
    setTimeout(refresh, REFRESH_MS);
  }
}

refresh();
