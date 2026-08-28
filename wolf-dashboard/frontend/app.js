const $ = (selector) => document.querySelector(selector);
const state = { watchlist: [], market: [] };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function fmtNumber(value, digits = 2) {
  if (value === null || value === undefined || value === '') return '--';
  return Number(value).toFixed(digits);
}

function statusClass(status) {
  if (status === 'ok' || status === 'ready') return 'ok';
  if (status === 'needs_configuration' || status === 'continued' || status === 'fallback') return 'warn';
  if (status === 'error' || status === 'needs_data') return 'error';
  return 'muted';
}

async function getJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
  return data;
}

function renderMarket(items) {
  state.market = items || [];
  const grid = $('#market-grid');
  if (!state.market.length) { grid.innerHTML = '<div class="empty-inline">还没有行情快照</div>'; return; }
  grid.innerHTML = state.market.map(item => {
    const change = item.change_pct;
    const direction = change === null || change === undefined ? '' : (change >= 0 ? 'up' : 'down');
    return `<div class="market-card ${item.status !== 'ok' ? 'error' : ''}">
      <span class="market-name">${escapeHtml(item.extra?.name || item.code)} · ${escapeHtml(item.code)}</span>
      <strong>${item.status === 'ok' ? fmtNumber(item.price) : '--'}</strong>
      <span class="${direction}">${change === null || change === undefined ? escapeHtml(item.error || '待核验') : `${change >= 0 ? '+' : ''}${fmtNumber(change)}%`}</span>
    </div>`;
  }).join('');
  const latest = state.market.map(x => x.snapshot_at).filter(Boolean).sort().pop();
  $('#market-asof').textContent = latest ? `快照 ${latest.replace('T', ' ')}` : '等待数据';
}

function renderPosts(items) {
  $('#post-count').textContent = items?.length || 0;
  const list = $('#post-list');
  if (!items?.length) { list.innerHTML = '<div class="empty-state">今天还没有检测到新的作者发言。</div>'; return; }
  list.innerHTML = items.map(post => `<article class="post-card">
    <div class="post-head"><strong>PID ${escapeHtml(post.pid)}</strong><span class="post-time">${escapeHtml(post.post_at || '时间待核验')}</span></div>
    <p>${escapeHtml(post.body || post.subject || '（空内容）')}</p>
    <a class="post-link" href="${escapeHtml(post.url)}" target="_blank" rel="noreferrer">在 NGA 打开 ↗</a>
  </article>`).join('');
}

function renderStrategies(versions) {
  const version = versions?.[0];
  const list = $('#strategy-list');
  if (!version) { $('#strategy-state').className = 'status-pill muted'; $('#strategy-state').textContent = '未生成'; list.innerHTML = '<div class="empty-state">点击“生成今日策略”，或等待 08:30 自动生成。</div>'; return; }
  const css = statusClass(version.status);
  $('#strategy-state').className = `status-pill ${css}`;
  $('#strategy-state').textContent = version.status === 'needs_configuration' ? '待配置 AI' : version.status;
  if (!version.items?.length) { list.innerHTML = '<div class="empty-state">策略版本已记录，但缺少可引用数据。</div>'; return; }
  list.innerHTML = version.items.map(item => `<article class="strategy-card">
    <h3><span>${escapeHtml(item.title)}</span><span class="stance">${escapeHtml(item.stance || 'observe')} · ${Math.round((item.confidence || 0) * 100)}%</span></h3>
    <p>${escapeHtml(item.details)}</p>
    <div class="strategy-meta"><span><strong>触发：</strong>${escapeHtml(item.triggers || '待补充')}</span><span><strong>失效：</strong>${escapeHtml(item.invalidation || '待补充')}</span>${item.continued_days ? `<span><strong>延续：</strong>第 ${item.continued_days} 天</span>` : ''}</div>
    <details class="evidence"><summary>查看依赖的发言与规则（${item.citations?.length || 0}）</summary>
      ${(item.citations || []).map(c => `<div class="citation"><a href="${escapeHtml(c.post?.url || `https://ngabbs.com/read.php?tid=47288722&pid=${encodeURIComponent(c.post_pid)}`)}" target="_blank" rel="noreferrer">PID ${escapeHtml(c.post_pid)} ↗</a><span> · ${escapeHtml(c.post?.post_at || '时间待核验')}</span>${c.quote ? `<div>“${escapeHtml(c.quote)}”</div>` : ''}<div class="citation-rule"><strong>规则 ${escapeHtml(c.rule_id)}</strong>${c.rule?.summary ? ` · ${escapeHtml(c.rule.summary)}` : ''}${c.rule?.evidence_ref ? `<br><span>证据：${escapeHtml(c.rule.evidence_ref)}</span>` : ''}</div></div>`).join('')}
    </details>
  </article>`).join('');
}

function renderWatchlist(items, market) {
  state.watchlist = items || [];
  const byCode = Object.fromEntries((market || []).map(item => [item.code, item]));
  const list = $('#watchlist-list');
  if (!state.watchlist.length) { list.innerHTML = '<div class="empty-state">自选池为空，默认只显示主要指数。</div>'; return; }
  list.innerHTML = state.watchlist.map(item => {
    const quote = byCode[item.code];
    const change = quote?.change_pct;
    const dir = change === null || change === undefined ? '' : change >= 0 ? 'up' : 'down';
    return `<div class="watch-row"><div><strong>${escapeHtml(item.name || item.code)}</strong><br><span>${escapeHtml(item.code)}${item.notes ? ` · ${escapeHtml(item.notes)}` : ''}</span></div><div class="watch-price"><strong>${quote?.status === 'ok' ? fmtNumber(quote.price) : '--'}</strong><span class="${dir}">${change === null || change === undefined ? '待核验' : `${change >= 0 ? '+' : ''}${fmtNumber(change)}%`}</span></div><button class="icon-button remove-watch" data-code="${escapeHtml(item.code)}" title="移出自选池" aria-label="移出自选池">×</button></div>`;
  }).join('');
}

function renderAliases(items) {
  const list = $('#alias-list');
  if (!items?.length) { list.innerHTML = '<div class="empty-inline">生成策略后显示候选映射</div>'; return; }
  list.innerHTML = items.map(item => `<div class="alias-row"><span>${escapeHtml(item.alias)} → ${escapeHtml(item.code)}</span><strong>${Math.round((item.confidence || 0) * 100)}%</strong><button class="icon-button edit-alias" data-alias="${escapeHtml(item.alias)}" data-code="${escapeHtml(item.code)}" title="手动纠正标的代码" aria-label="手动纠正标的代码">✎</button></div>`).join('');
}

function renderStatus(data) {
  const cfg = data.configuration || {};
  const crawl = data.last_crawl;
  $('#today-label').textContent = (data.now || '').slice(0, 10) || '--';
  const rows = [
    ['NGA Cookie', cfg.nga_cookie ? '已配置' : '未配置', cfg.nga_cookie ? 'ok' : 'warn'],
    ['AI 接口', cfg.ai_credentials ? '已配置' : '未配置', cfg.ai_credentials ? 'ok' : 'warn'],
    ['定时任务', cfg.scheduler ? '运行中' : '未启动', cfg.scheduler ? 'ok' : 'warn'],
    ['数据规模', `${data.counts?.posts || 0} 条发言 · ${data.counts?.rules || 0} 条规则`, 'muted'],
    ['最近检查', crawl ? `${crawl.finished_at || crawl.started_at} · ${crawl.status}` : '尚未检查', crawl?.status === 'ok' ? 'ok' : crawl ? 'error' : 'muted'],
  ];
  $('#status-list').innerHTML = rows.map(([label, value, css]) => `<div class="status-row"><span>${escapeHtml(label)}</span><span class="status-pill ${css}">${escapeHtml(value)}</span></div>`).join('');
  const live = $('#live-state'); live.className = 'status-pill ok'; live.textContent = '已连接';
}

async function loadAll() {
  try {
    const [status, posts, strategies, watchlist, aliases] = await Promise.all([
      getJson('/api/status'), getJson('/api/posts?date=today&limit=50'), getJson('/api/strategies?limit=10'), getJson('/api/watchlist'), getJson('/api/aliases')
    ]);
    renderStatus(status); renderMarket(status.market || watchlist.market); renderPosts(posts.items); renderStrategies(strategies.items); renderWatchlist(watchlist.items, watchlist.market || status.market); renderAliases(aliases.items);
  } catch (error) {
    const live = $('#live-state'); live.className = 'status-pill error'; live.textContent = '接口错误';
    console.error(error);
  }
}

async function runTask(endpoint, button) {
  const original = button.innerHTML; button.disabled = true; button.innerHTML = '… <span>处理中</span>';
  try { await getJson(endpoint, { method: 'POST' }); await loadAll(); }
  catch (error) { window.alert(error.message); }
  finally { button.disabled = false; button.innerHTML = original; }
}

$('#refresh-all').addEventListener('click', loadAll);
$('#crawl-now').addEventListener('click', (event) => runTask('/api/tasks/crawl', event.currentTarget));
$('#strategy-now').addEventListener('click', (event) => runTask('/api/tasks/strategy?kind=baseline', event.currentTarget));
$('#watchlist-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = $('#watch-code').value.trim(); if (!code) return;
  const items = [...state.watchlist, { code, name: $('#watch-name').value.trim(), asset_type: 'stock', enabled: true, notes: '' }];
  try { const result = await getJson('/api/watchlist', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) }); renderWatchlist(result.items, result.market); $('#watch-code').value = ''; $('#watch-name').value = ''; }
  catch (error) { window.alert(error.message); }
});
$('#watchlist-list').addEventListener('click', async (event) => {
  const button = event.target.closest('.remove-watch');
  if (!button) return;
  try { const result = await getJson(`/api/watchlist/${encodeURIComponent(button.dataset.code)}`, { method: 'DELETE' }); renderWatchlist(result.items, result.market); }
  catch (error) { window.alert(error.message); }
});
$('#alias-list').addEventListener('click', async (event) => {
  const button = event.target.closest('.edit-alias');
  if (!button) return;
  const code = window.prompt(`为“${button.dataset.alias}”输入证券代码`, button.dataset.code);
  if (!code) return;
  try { await getJson(`/api/aliases/${encodeURIComponent(button.dataset.alias)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, confidence: 1, source: 'manual' }) }); await loadAll(); }
  catch (error) { window.alert(error.message); }
});

try {
  const source = new EventSource('/api/events');
  source.onmessage = () => loadAll();
  source.onerror = () => { $('#live-state').className = 'status-pill warn'; $('#live-state').textContent = '重连中'; };
} catch (_) { /* EventSource unavailable; polling below remains active. */ }

loadAll();
setInterval(loadAll, 30000);
