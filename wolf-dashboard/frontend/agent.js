const $ = (selector) => document.querySelector(selector);

// Pure target-selection and OHLCV/MA merge rules live in agent-market.js so
// they can be covered by `node --test` without a browser.
const marketHelpers = globalThis.WolfAgentMarket || null;
const CHART_IDLE_HINT = '识别到唯一标的后将自动显示；也可点击候选行切换。';

const FINAL_STATUSES = new Set([
  'completed',
  'insufficient_evidence',
  'needs_configuration',
  'cancelled',
  'timeout',
  'failed',
]);
const ACTIVE_STATUSES = new Set(['pending', 'running', 'cancelling']);
const SSE_EVENT_TYPES = [
  'run_started',
  'skill_selected',
  'assistant_message',
  'text_delta',
  'tool_started',
  'tool_completed',
  'tool_failed',
  'terminal_submitted',
  'run_finished',
  'run_failed',
  'run_cancelled',
];

const state = {
  mode: 'auto',
  skills: [],
  run: null,
  runId: '',
  events: [],
  seenEventIds: new Set(),
  seenSequences: new Set(),
  cursor: 0,
  stream: null,
  reconnectTimer: null,
  reconnectAttempt: 0,
  selectedCandidate: null,
  chartSelectionMode: 'auto',
  chartAutoLoadKey: '',
  marketRequest: 0,
  candidateResult: null,
  candidateData: null,
  candidateHydrationKey: '',
  candidateError: '',
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[char]));
}

function escapeXml(value) {
  return escapeHtml(value);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '--';
  return Number(value).toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function formatCompactNumber(value) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '--';
  const number = Number(value);
  if (Math.abs(number) >= 100000000) return `${(number / 100000000).toFixed(2)} 亿`;
  if (Math.abs(number) >= 10000) return `${(number / 10000).toFixed(2)} 万`;
  return number.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
}

function formatDate(value) {
  if (!value) return '--';
  const text = String(value).replace('T', ' ');
  return text.length > 19 ? text.slice(0, 19) : text;
}

function shortId(value) {
  const text = String(value || '');
  return text.length > 12 ? `${text.slice(0, 8)}...${text.slice(-4)}` : text;
}

function jsonPreview(value) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch (_) {
    return '{}';
  }
}

function errorMessage(error, fallback = '请求失败') {
  if (!error) return fallback;
  if (typeof error === 'string') return error;
  if (error.message) return error.message;
  return fallback;
}

function errorCode(error) {
  return String(error?.code || '').toUpperCase();
}

async function getJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = { detail: text };
    }
  }
  if (!response.ok) {
    const detail = isObject(data.detail) ? data.detail : {};
    const error = new Error(detail.message || data.detail || `HTTP ${response.status}`);
    error.code = detail.code || data.code || `HTTP_${response.status}`;
    error.status = response.status;
    throw error;
  }
  return data;
}

function setAlert(message, kind = 'error') {
  const element = $('#global-alert');
  if (!element) return;
  element.textContent = message || '';
  element.className = `alert ${kind}`;
  element.hidden = !message;
}

function setConnection(kind, label) {
  const element = $('#connection-state');
  if (!element) return;
  element.className = `state-dot ${kind}`;
  element.innerHTML = `<span aria-hidden="true"></span>${escapeHtml(label)}`;
}

function setStreamState(label) {
  const element = $('#stream-state');
  if (element) element.textContent = label;
}

function isActive(status = state.run?.status) {
  return ACTIVE_STATUSES.has(String(status || ''));
}

function statusLabel(status) {
  return ({
    pending: '排队中',
    running: '运行中',
    cancelling: '取消中',
    completed: '已完成',
    insufficient_evidence: '证据不足',
    needs_configuration: '待配置',
    cancelled: '已取消',
    timeout: '已超时',
    failed: '失败',
  })[status] || (status ? String(status) : '未开始');
}

function statusClass(status) {
  if (ACTIVE_STATUSES.has(status)) return 'active';
  if (status === 'completed') return 'done';
  if (status === 'insufficient_evidence' || status === 'needs_configuration' || status === 'timeout') return 'warn';
  if (status === 'failed') return 'error';
  return 'neutral';
}

function setMode(mode) {
  if (!['auto', 'manual', 'none'].includes(mode)) return;
  state.mode = mode;
  document.querySelectorAll('.segment').forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const field = $('#manual-skill-field');
  if (field) field.hidden = mode !== 'manual';
  const hint = $('#form-hint');
  if (hint) hint.textContent = mode === 'auto' ? '运行会根据问题选择已启用 Skill。' : mode === 'manual' ? '仅允许加载当前选择的 Skill。' : '本次运行不会加载 Skill。';
}

function renderSkillOptions() {
  const select = $('#skill-select');
  if (!select) return;
  const enabled = state.skills.filter((skill) => skill.enabled === true || skill.enabled === 1);
  if (!enabled.length) {
    select.innerHTML = '<option value="">没有已启用 Skill</option>';
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.innerHTML = enabled.map((skill) => `<option value="${escapeHtml(skill.id || skill.skill_id)}">${escapeHtml(skill.name || skill.id || skill.skill_id)} · v${escapeHtml(skill.version || '--')}</option>`).join('');
}

async function loadSkills() {
  try {
    const data = await getJson('/api/v1/skills');
    state.skills = Array.isArray(data.items) ? data.items : [];
    renderSkillOptions();
    setConnection('online', 'API 已连接');
  } catch (error) {
    state.skills = [];
    renderSkillOptions();
    setConnection('offline', 'API 不可用');
    setAlert(`无法读取 Skill 列表：${errorMessage(error)}`);
  }
}

function resetRunState() {
  closeStream();
  state.run = null;
  state.runId = '';
  state.events = [];
  state.seenEventIds = new Set();
  state.seenSequences = new Set();
  state.cursor = 0;
  state.selectedCandidate = null;
  state.chartSelectionMode = 'auto';
  state.chartAutoLoadKey = '';
  state.candidateResult = null;
  state.candidateData = null;
  state.candidateHydrationKey = '';
  state.candidateError = '';
  state.marketRequest += 1;
  renderRun();
  renderCandidates();
  renderEvidence();
  renderBoard();
  setChartIdentity(null);
  renderChartEmpty(CHART_IDLE_HINT, '等待标的');
}

function normalizeRunEvent(event, fallbackType = '') {
  if (!isObject(event)) return null;
  const payload = isObject(event.payload) ? event.payload : {};
  const sequenceValue = event.sequence ?? event.id ?? payload.sequence;
  const sequence = Number.isFinite(Number(sequenceValue)) ? Number(sequenceValue) : 0;
  const eventId = String(event.event_id || event.eventId || event.lastEventId || `${state.runId}:${sequence}`);
  return {
    ...event,
    type: String(event.type || fallbackType || 'event'),
    payload,
    sequence,
    event_id: eventId,
    occurred_at: event.occurred_at || event.timestamp || event.occurredAt || '',
  };
}

function ingestEvent(rawEvent, fallbackType = '') {
  const event = normalizeRunEvent(rawEvent, fallbackType);
  if (!event) return false;
  const sequenceKey = event.sequence > 0 ? event.sequence : null;
  if (state.seenEventIds.has(event.event_id) || (sequenceKey !== null && state.seenSequences.has(sequenceKey))) return false;
  state.seenEventIds.add(event.event_id);
  if (sequenceKey !== null) {
    state.seenSequences.add(sequenceKey);
    state.cursor = Math.max(state.cursor, sequenceKey);
  }
  state.events.push(event);
  state.events.sort((left, right) => (left.sequence || 0) - (right.sequence || 0));
  if (state.run) {
    const payload = event.payload || {};
    if (event.type === 'run_finished' && payload.status) state.run.status = payload.status;
    if (event.type === 'run_failed') {
      state.run.status = 'failed';
      state.run.error = payload.error || payload;
    }
    if (event.type === 'run_cancelled') state.run.status = 'cancelled';
    if (event.type === 'terminal_submitted' && payload.status) {
      state.run.status = payload.status;
      state.run.terminal_status = payload.status;
      state.run.answer = payload;
    }
  }
  if (event.type === 'tool_failed' && ['screen_stocks', 'get_preset_candidates'].includes(toolName(event))) {
    const message = event.payload?.error?.message || '候选工具调用失败。';
    state.candidateError = `候选工具失败：${message}`;
  }
  renderRun();
  renderTrace();
  renderEvidence();
  renderCandidates();
  renderBoard();
  if (event.type === 'tool_started' || event.type === 'tool_completed') hydrateCandidates(event);
  if (event.type === 'tool_completed') maybeAutoLoadChart();
  if (event.type === 'run_finished' || event.type === 'run_failed' || event.type === 'run_cancelled') {
    window.setTimeout(() => syncRun({ closeWhenFinal: true }), 80);
  }
  return true;
}

function closeStream() {
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
  if (state.reconnectTimer) {
    window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

function handleSseMessage(message, fallbackType = '') {
  let data;
  try {
    data = JSON.parse(message.data);
  } catch (_) {
    setStreamState('事件格式错误');
    return;
  }
  if (!isObject(data)) return;
  if (!data.event_id && message.lastEventId) data.event_id = message.lastEventId;
  ingestEvent(data, fallbackType || message.type);
}

function scheduleReconnect() {
  if (!state.runId || !isActive(state.run?.status)) return;
  if (state.reconnectTimer) return;
  state.reconnectAttempt += 1;
  const delay = Math.min(6000, 500 * (2 ** Math.min(state.reconnectAttempt - 1, 4)));
  setStreamState(`重连中 · ${Math.ceil(delay / 1000)}s`);
  state.reconnectTimer = window.setTimeout(() => {
    state.reconnectTimer = null;
    openStream();
  }, delay);
}

function openStream() {
  if (!state.runId || !isActive(state.run?.status)) return;
  closeStream();
  const query = `?after=${encodeURIComponent(state.cursor)}`;
  const source = new EventSource(`/api/v1/runs/${encodeURIComponent(state.runId)}/events${query}`);
  state.stream = source;
  setStreamState(state.cursor ? `恢复中 · 游标 ${state.cursor}` : '连接中');
  source.onopen = () => {
    state.reconnectAttempt = 0;
    setStreamState(state.cursor ? `已恢复 · 游标 ${state.cursor}` : '已连接');
  };
  SSE_EVENT_TYPES.forEach((type) => source.addEventListener(type, (message) => handleSseMessage(message, type)));
  source.onmessage = (message) => handleSseMessage(message);
  source.onerror = () => {
    if (state.stream !== source) return;
    source.close();
    state.stream = null;
    if (isActive(state.run?.status)) {
      setStreamState('连接中断');
      syncRun({ closeWhenFinal: true, reconnect: true });
    } else {
      setStreamState('已结束');
    }
  };
}

function updateRunFromRecord(record) {
  if (!record || !isObject(record)) return;
  if (!state.runId) state.runId = String(record.id || record.run_id || '');
  state.run = { ...(state.run || {}), ...record };
  if (state.runId && Array.isArray(record.events)) {
    record.events.forEach((event) => ingestEvent(event));
  }
  renderRun();
  renderTrace();
  renderEvidence();
  renderCandidates();
  renderBoard();
  maybeAutoLoadChart();
}

async function syncRun(options = {}) {
  if (!state.runId) return null;
  try {
    const record = await getJson(`/api/v1/runs/${encodeURIComponent(state.runId)}`);
    updateRunFromRecord(record);
    setConnection('online', 'API 已连接');
    if (FINAL_STATUSES.has(String(record.status))) {
      closeStream();
      setStreamState('已结束');
      if (options.closeWhenFinal !== false) state.reconnectAttempt = 0;
    } else if (options.reconnect && !state.stream) {
      openStream();
    }
    return record;
  } catch (error) {
    if (error.status === 404) {
      setAlert(`运行 ${shortId(state.runId)} 不存在。`);
      closeStream();
    } else if (options.reconnect) {
      scheduleReconnect();
    } else {
      setAlert(`无法读取运行状态：${errorMessage(error)}`);
    }
    return null;
  }
}

function buildRunPayload() {
  const question = $('#question-input')?.value.trim() || '';
  if (!question) throw new Error('请先填写研究问题。');
  const payload = { question, skill_mode: state.mode };
  if (state.mode === 'manual') {
    const skillId = $('#skill-select')?.value;
    if (!skillId) throw new Error('手动模式需要选择已启用 Skill。');
    payload.skill_id = skillId;
  }
  return payload;
}

async function startRun(event) {
  event.preventDefault();
  if (isActive()) return;
  let payload;
  try {
    payload = buildRunPayload();
  } catch (error) {
    setAlert(errorMessage(error));
    return;
  }
  setAlert('');
  resetRunState();
  $('#run-button').disabled = true;
  $('#cancel-button').disabled = true;
  $('#form-state').textContent = '提交中';
  try {
    const record = await getJson('/api/v1/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    state.runId = String(record.id || record.run_id || '');
    state.run = record;
    sessionStorage.setItem('wolf.agent.run', state.runId);
    updateRunFromRecord(record);
    renderRun();
    setConnection('online', 'API 已连接');
    setStreamState('准备连接');
    openStream();
  } catch (error) {
    const offline = error.status === 503 || errorCode(error).includes('SIDECAR');
    setConnection('offline', offline ? 'Sidecar 离线' : 'API 错误');
    setAlert(offline ? `Sidecar 离线：${errorMessage(error)}` : `无法开始运行：${errorMessage(error)}`);
    $('#form-state').textContent = offline ? 'Sidecar 离线' : '请求失败';
    renderFailedStart(offline ? 'sidecar_offline' : 'error', errorMessage(error));
  } finally {
    if (!isActive()) $('#run-button').disabled = false;
  }
}

async function cancelRun() {
  if (!state.runId || !isActive()) return;
  $('#cancel-button').disabled = true;
  $('#form-state').textContent = '取消中';
  try {
    const result = await getJson(`/api/v1/runs/${encodeURIComponent(state.runId)}/cancel`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    if (state.run) state.run.status = result.status === 'cancelled' ? 'cancelled' : 'cancelling';
    renderRun();
    setStreamState('等待取消确认');
    await syncRun({ reconnect: true });
  } catch (error) {
    setAlert(`取消失败：${errorMessage(error)}`);
    $('#cancel-button').disabled = false;
  }
}

function renderFailedStart(kind, message) {
  const status = kind === 'sidecar_offline' ? 'failed' : 'failed';
  state.run = { id: '', status, error: { code: kind === 'sidecar_offline' ? 'SIDECAR_UNAVAILABLE' : 'REQUEST_FAILED', message } };
  state.events = [];
  renderRun();
  renderTrace();
}

function renderRun() {
  const run = state.run || {};
  const status = String(run.status || '');
  const badge = $('#run-status');
  if (badge) {
    badge.className = `status-badge ${statusClass(status)}`;
    badge.textContent = statusLabel(status);
  }
  const detail = $('#run-status-detail');
  const code = run.error?.code || run.error?.error?.code;
  if (detail) {
    if (code === 'SIDECAR_UNAVAILABLE') detail.textContent = 'Sidecar 离线，未生成结论';
    else if (status === 'insufficient_evidence') detail.textContent = '保留已获取证据，未提交占位结论';
    else if (status === 'needs_configuration') detail.textContent = 'Provider 尚未配置';
    else if (status === 'cancelled') detail.textContent = '运行已取消';
    else if (status === 'failed') detail.textContent = run.error?.message || '运行未完成';
    else if (status) detail.textContent = status === 'completed' ? '终端提交已验证' : '正在接收公开事件';
    else detail.textContent = '提交问题后显示';
  }
  const budget = Number(run.budget_tokens);
  $('#run-budget').textContent = Number.isFinite(budget) && budget > 0 ? `${formatCompactNumber(budget)} tokens` : '-- tokens';
  const usage = latestUsage();
  $('#run-usage').textContent = usage === null ? '已用 --' : `已用 ${formatCompactNumber(usage)} tokens`;
  $('#event-count').textContent = String(state.events.length);
  $('#event-cursor').textContent = `游标 ${state.cursor}`;
  $('#run-model').textContent = run.model || '--';
  $('#run-updated').textContent = run.updated_at ? formatDate(run.updated_at) : '尚未更新';
  $('#intro-run-id').textContent = state.runId ? shortId(state.runId) : '尚未开始';
  $('#intro-run-time').textContent = run.created_at ? formatDate(run.created_at) : '等待问题';
  const active = isActive(status);
  $('#run-button').disabled = active;
  $('#cancel-button').disabled = !active;
  if ($('#form-state') && !active && status) $('#form-state').textContent = statusLabel(status);
  renderAnswer();
}

function latestUsage() {
  const finished = [...state.events].reverse().find((event) => event.type === 'run_finished');
  const usage = finished?.payload?.usage;
  if (typeof usage === 'number') return usage;
  if (isObject(usage)) {
    for (const key of ['totalTokens', 'total_tokens', 'outputTokens', 'output_tokens', 'tokens']) {
      if (Number.isFinite(Number(usage[key]))) return Number(usage[key]);
    }
  }
  return null;
}

function toolName(event) {
  const payload = event.payload || {};
  return payload.tool_call?.name || payload.toolCall?.name || event.tool || 'tool';
}

function eventDetail(event) {
  const payload = event.payload || {};
  if (event.type === 'tool_started') return payload.tool_call?.arguments || payload.toolCall?.arguments || null;
  if (event.type === 'tool_completed' || event.type === 'tool_failed') return payload;
  if (event.type === 'skill_selected') return payload.skill || payload;
  if (event.type === 'terminal_submitted') return { status: payload.status, evidence: payload.evidence, dataAsOf: payload.dataAsOf, limitations: payload.limitations };
  if (event.type === 'run_finished') return payload;
  return null;
}

function eventPresentation(event) {
  const payload = event.payload || {};
  switch (event.type) {
    case 'run_started': return ['运行已创建', 'Agent 已接收问题', 'start'];
    case 'skill_selected': return ['Skill 已选择', payload.skill_id || payload.skill?.id || '自动选择', 'skill'];
    case 'assistant_message': return ['模型请求已记录', `${(payload.tool_calls || []).length} 个工具调用`, 'model'];
    case 'text_delta': return ['模型输出已收集', `${payload.chars || 0} 个字符`, 'model'];
    case 'tool_started': return [`开始 ${toolName(event)}`, payload.operation_id ? `operation ${shortId(payload.operation_id)}` : '读取中', 'tool'];
    case 'tool_completed': return [`完成 ${toolName(event)}`, payload.ok === false ? '调用失败' : '已取得公开数据', payload.ok === false ? 'failed' : 'tool'];
    case 'tool_failed': return [`${toolName(event)} 失败`, payload.error?.message || '工具返回错误', 'failed'];
    case 'terminal_submitted': return ['终端结果已提交', payload.status === 'insufficient_evidence' ? '证据不足' : 'completed', 'terminal'];
    case 'run_finished': return ['运行结束', statusLabel(payload.status || 'completed'), payload.status === 'completed' ? 'terminal' : 'failed'];
    case 'run_failed': return ['运行失败', payload.error?.message || payload.message || 'sidecar 返回失败', 'failed'];
    case 'run_cancelled': return ['运行已取消', payload.reason || '用户请求取消', 'failed'];
    default: return [event.type, '公开事件', 'model'];
  }
}

function renderTrace() {
  const list = $('#trace-list');
  if (!list) return;
  if (!state.events.length) {
    list.innerHTML = '<div class="empty-state"><span class="empty-icon" aria-hidden="true">○</span><span>运行开始后，工具调用会按顺序出现在这里。</span></div>';
    return;
  }
  const wasNearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  list.innerHTML = state.events.map((event) => {
    const [title, summary, kind] = eventPresentation(event);
    const detail = eventDetail(event);
    const detailBlock = detail && Object.keys(detail).length ? `<details class="trace-details"><summary>查看公开摘要</summary><pre>${escapeHtml(jsonPreview(detail))}</pre></details>` : '';
    return `<article class="trace-entry ${kind === 'failed' ? 'failed' : ''} ${kind === 'terminal' ? 'terminal' : ''}">
      <span class="trace-marker" aria-hidden="true">${kind === 'failed' ? '!' : kind === 'terminal' ? '✓' : kind === 'tool' ? '↗' : '·'}</span>
      <div class="trace-content"><div class="trace-head"><strong>${escapeHtml(title)}</strong><time datetime="${escapeHtml(event.occurred_at)}">${escapeHtml(formatDate(event.occurred_at))} · #${escapeHtml(event.sequence || '')}</time></div><p class="trace-summary">${escapeHtml(summary)}</p>${detailBlock}</div>
    </article>`;
  }).join('');
  if (wasNearBottom) list.scrollTop = list.scrollHeight;
}

function answerFromState() {
  const answer = state.run?.answer;
  if (isObject(answer) && typeof answer.answer === 'string') return answer;
  const submitted = [...state.events].reverse().find((event) => event.type === 'terminal_submitted' && typeof event.payload?.answer === 'string');
  return submitted ? submitted.payload : null;
}

function renderAnswer() {
  const body = $('#answer-body');
  const meta = $('#answer-meta');
  const label = $('#answer-state');
  if (!body || !meta || !label) return;
  const answer = answerFromState();
  const status = String(state.run?.status || answer?.status || '');
  const error = state.run?.error;
  body.className = `answer-body${status === 'insufficient_evidence' ? ' insufficient' : ''}`;
  if (answer?.answer) {
    body.textContent = answer.answer;
    label.textContent = status === 'insufficient_evidence' ? '证据不足' : '已提交';
  } else if (status === 'needs_configuration') {
    body.textContent = 'Provider 尚未配置，当前运行没有生成投资结论。';
    label.textContent = '待配置';
  } else if (error?.code === 'SIDECAR_UNAVAILABLE') {
    body.textContent = 'Sidecar 离线，运行未进入可结论状态。';
    label.textContent = 'Sidecar 离线';
  } else if (status === 'cancelled') {
    body.textContent = '本次运行已取消，未提交最终回答。';
    label.textContent = '已取消';
  } else if (status === 'failed') {
    body.textContent = error?.message || '运行失败，未提交最终回答。';
    label.textContent = '未提交';
  } else {
    body.textContent = '终端工具提交后，回答会显示在这里。';
    body.classList.add('empty-copy');
    label.textContent = '等待提交';
  }
  const rows = [];
  if (answer?.dataAsOf || answer?.data_as_of) rows.push(`<span><strong>数据截至</strong> ${escapeHtml(answer.dataAsOf || answer.data_as_of)}</span>`);
  if (Array.isArray(answer?.limitations) && answer.limitations.length) rows.push(`<span><strong>限制</strong> ${escapeHtml(answer.limitations.join('；'))}</span>`);
  if (answer?.riskDisclaimer || answer?.risk_disclaimer) rows.push(`<span><strong>风险提示</strong> ${escapeHtml(answer.riskDisclaimer || answer.risk_disclaimer)}</span>`);
  meta.innerHTML = rows.join('');
  meta.hidden = !rows.length;
}

function candidateObjects() {
  const candidateTools = new Set(['screen_stocks', 'get_preset_candidates']);
  const results = [];
  const visit = (value, depth = 0) => {
    if (!value || depth > 4) return;
    if (Array.isArray(value)) {
      if (value.some((item) => isObject(item) && (item.symbol || item.code))) value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (!isObject(value)) return;
    for (const key of ['candidates', 'results', 'items']) {
      if (Array.isArray(value[key])) {
        value[key].forEach((item) => {
          if (isObject(item) && (item.symbol || item.code)) results.push(item);
        });
      }
    }
    if (isObject(value.data)) visit(value.data, depth + 1);
    if (isObject(value.metadata)) visit(value.metadata, depth + 1);
  };
  state.events.forEach((event) => {
    if (event.type !== 'tool_completed' || event.payload?.ok === false || !candidateTools.has(toolName(event))) return;
    visit(event.payload?.data || event.payload, 0);
  });
  if (state.candidateData) visit(state.candidateData, 0);
  (state.run?.artifacts || []).forEach((artifact) => {
    if (artifact.artifact_type === 'candidate_table') visit(artifact.metadata, 0);
  });
  const unique = new Map();
  results.forEach((item) => {
    const key = String(item.symbol || item.code);
    if (key && !unique.has(key)) unique.set(key, item);
  });
  return [...unique.values()];
}

function candidateValue(candidate, key) {
  const values = isObject(candidate.values) ? candidate.values : {};
  return candidate[key] ?? values[key] ?? candidate.metrics?.[key] ?? candidate.features?.[key];
}

function findScreenerResult() {
  let result = state.candidateData || null;
  const visit = (value, depth = 0) => {
    if (!value || depth > 4 || result) return;
    if (!isObject(value)) return;
    if (value.matched_count !== undefined || value.total_candidates !== undefined || value.empty_result !== undefined || value.coverage_warning) result = value;
    if (isObject(value.data)) visit(value.data, depth + 1);
  };
  state.events.forEach((event) => visit(event.payload));
  return result;
}

function renderCandidates() {
  const body = $('#candidate-body');
  const summary = $('#candidate-summary');
  const quality = $('#candidate-quality');
  if (!body || !summary || !quality) return;
  const candidates = candidateObjects();
  const result = findScreenerResult();
  state.candidateResult = result;
  if (!candidates.length) {
    const zero = Number(result?.matched_count ?? result?.total_candidates) === 0 || result?.empty_result === true;
    const insufficient = state.run?.status === 'insufficient_evidence';
    summary.textContent = zero ? '0 个候选' : insufficient ? '证据不足' : '暂无结果';
    body.innerHTML = `<tr><td colspan="7" class="table-empty">${zero ? '筛选覆盖充分，但没有标的满足全部条件。' : insufficient ? 'Agent 未获得足够证据，候选列表为空。' : '尚未获取候选标的。'}</td></tr>`;
    const warning = state.candidateError || result?.coverage_warning || result?.data_quality?.warnings?.join('；') || (insufficient ? '当前运行未提交可核验的候选证据。' : '');
    quality.textContent = warning;
    quality.hidden = !warning;
    return;
  }
  summary.textContent = `${candidates.length} 个候选`;
  const warning = state.candidateError || result?.coverage_warning || result?.data_quality?.warnings?.join('；') || '';
  quality.textContent = warning;
  quality.hidden = !warning;
  body.innerHTML = candidates.map((candidate) => {
    const key = String(candidate.symbol || candidate.code);
    const selected = state.selectedCandidate && String(state.selectedCandidate.symbol || state.selectedCandidate.code) === key;
    const return20 = candidateValue(candidate, 'return_20d_pct');
    const ma5 = candidateValue(candidate, 'ma5');
    const ma20 = candidateValue(candidate, 'ma20');
    return `<tr class="${selected ? 'selected' : ''}">
      <td>${escapeHtml(candidate.code || key)}</td><td>${escapeHtml(candidate.name || '--')}</td><td>${escapeHtml(formatNumber(candidateValue(candidate, 'close')))}</td><td>${escapeHtml(formatNumber(return20))}${return20 === null || return20 === undefined ? '' : '%'}</td><td>${escapeHtml(formatNumber(ma5))} / ${escapeHtml(formatNumber(ma20))}</td><td>${escapeHtml(formatNumber(candidate.score, 1))}</td><td><button type="button" class="candidate-select" data-symbol="${escapeHtml(key)}">查看</button></td>
    </tr>`;
  }).join('');
}

async function hydrateCandidates(event) {
  const payload = event.payload || {};
  const callId = String(payload.tool_call?.id || payload.toolCall?.id || '');
  if (!callId) return;
  const started = [...state.events].reverse().find((item) => {
    if (item.type !== 'tool_started') return false;
    const startedPayload = item.payload || {};
    const startedId = String(startedPayload.tool_call?.id || startedPayload.toolCall?.id || '');
    return startedId && startedId === callId;
  });
  const completed = [...state.events].reverse().find((item) => {
    if (item.type !== 'tool_completed') return false;
    const completedPayload = item.payload || {};
    const completedId = String(completedPayload.tool_call?.id || completedPayload.toolCall?.id || '');
    return completedId && completedId === callId && completedPayload.ok !== false;
  });
  if (!started || !completed) return;
  const tool = toolName(completed);
  if (tool !== 'screen_stocks' && tool !== 'get_preset_candidates') return;
  const startedPayload = started?.payload || {};
  const argumentsValue = startedPayload.tool_call?.arguments || startedPayload.toolCall?.arguments;
  if (!isObject(argumentsValue)) return;
  let request;
  if (tool === 'screen_stocks') {
    if (!Array.isArray(argumentsValue.conditions) || !Array.isArray(argumentsValue.sort)) return;
    request = { path: '/api/v1/research/screeners/a-share/query', init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ...argumentsValue, universe_id: 'a-share' }),
    } };
  } else {
    if (typeof argumentsValue.mode !== 'string') return;
    const query = new URLSearchParams({ universe_id: 'a-share', mode: argumentsValue.mode });
    if (typeof argumentsValue.as_of === 'string' && argumentsValue.as_of) query.set('as_of', argumentsValue.as_of);
    if (Number.isInteger(argumentsValue.limit)) query.set('limit', String(argumentsValue.limit));
    request = { path: `/api/v1/research/screeners/a-share/short-term-candidates?${query.toString()}`, init: {
      method: 'GET',
      headers: { Accept: 'application/json' },
    } };
  }
  const hydrationKey = callId || String(event.event_id || event.sequence || tool);
  if (state.candidateHydrationKey === hydrationKey) return;
  state.candidateHydrationKey = hydrationKey;
  try {
    const result = await getJson(request.path, request.init);
    if (state.candidateHydrationKey !== hydrationKey) return;
    state.candidateData = result;
    state.candidateError = '';
    renderCandidates();
  } catch (error) {
    if (state.candidateHydrationKey !== hydrationKey) return;
    state.candidateError = `候选表读取失败：${errorMessage(error)}`;
    renderCandidates();
  }
}

const BOARD_TOOLS = new Set(['get_market_session_context', 'resolve_board', 'get_board_snapshot', 'get_board_breadth', 'get_board_members']);
const PHASE_LABELS = {
  pre_open: '盘前',
  opening_auction: '集合竞价',
  morning_session: '早盘',
  lunch_break: '午间休市',
  afternoon_session: '午盘',
  post_close: '盘后',
  non_trading_day: '非交易日',
};

/** Collect the most recent successful payload of each board tool. */
function boardEvidence() {
  const byTool = new Map();
  state.events.forEach((event) => {
    if (event.type !== 'tool_completed') return;
    const payload = event.payload || {};
    if (payload.ok === false) return;
    const tool = payload.tool_call?.name || payload.toolCall?.name || '';
    if (!BOARD_TOOLS.has(tool) || !isObject(payload.data)) return;
    byTool.set(tool, payload.data);
  });
  (state.run?.artifacts || []).forEach((artifact) => {
    const metadata = artifact.metadata;
    if (!isObject(metadata)) return;
    const type = String(artifact.artifact_type || '');
    if (type === 'market_context' && !byTool.has('get_market_session_context')) byTool.set('get_market_session_context', metadata);
    if (type === 'board_evidence' && !byTool.has('get_board_snapshot')) byTool.set('get_board_snapshot', metadata);
    if (type === 'board_members' && !byTool.has('get_board_members')) byTool.set('get_board_members', metadata);
  });
  return byTool;
}

function marketContextFrom(byTool) {
  for (const key of ['get_board_snapshot', 'get_board_breadth', 'get_board_members']) {
    const value = byTool.get(key);
    if (isObject(value?.market_context)) return value.market_context;
  }
  const session = byTool.get('get_market_session_context');
  return isObject(session) ? session : null;
}

function renderBoardContext(context) {
  const element = $('#board-context');
  if (!element) return;
  if (!context) {
    element.hidden = true;
    return;
  }
  const phase = PHASE_LABELS[context.phase] || context.phase || '';
  const effective = context.effective_trade_date || '';
  const parts = [];
  if (context.fallback_reason && effective) {
    const requested = context.requested_date || context.calendar_date || '';
    parts.push(`${requested} ${phase}，当日尚无可用行情，已回退至 ${effective}`);
  } else if (context.intraday) {
    parts.push(`${phase} · 当前交易日 ${effective} 仍在变化`);
  } else if (effective) {
    parts.push(`${phase} · 数据日期 ${effective}`);
  }
  if (context.observed_at) parts.push(`查询时点 ${formatDate(context.observed_at)}（${context.timezone || 'Asia/Shanghai'}）`);
  if (context.calendar_basis === 'weekday_only') parts.push('交易日仅按工作日规则推断，未核验节假日');
  element.className = `board-context${context.fallback_reason ? ' fallback' : ''}${context.intraday ? ' intraday' : ''}`;
  element.textContent = parts.join(' · ');
  element.hidden = !parts.length;
}

function renderBoardIdentity(board) {
  const element = $('#board-identity');
  if (!element) return;
  if (!board) {
    element.hidden = true;
    return;
  }
  const rows = [
    ['板块', board.name],
    ['分类', board.board_type],
    ['来源', board.provider],
    ['成分口径', board.constituent_basis],
  ].filter(([, value]) => value);
  element.innerHTML = rows.map(([label, value]) => `<span><strong>${escapeHtml(label)}</strong> ${escapeHtml(value)}</span>`).join('');
  element.hidden = !rows.length;
}

function renderBoardMetrics(snapshot) {
  const element = $('#board-metrics');
  if (!element) return;
  if (!snapshot) {
    element.hidden = true;
    return;
  }
  const breadth = isObject(snapshot.breadth) ? snapshot.breadth : {};
  const coverage = isObject(snapshot.coverage) ? snapshot.coverage : {};
  const change = snapshot.change_pct;
  const changeClass = !Number.isFinite(Number(change)) ? '' : Number(change) >= 0 ? ' up' : ' down';
  const advancers = breadth.advancers;
  const decliners = breadth.decliners;
  const cells = [
    {
      label: '板块涨跌',
      value: Number.isFinite(Number(change)) ? `${formatNumber(change)}%` : '--',
      hint: snapshot.trade_date ? `交易日 ${snapshot.trade_date}` : '',
      klass: changeClass,
    },
    {
      label: '上涨 / 下跌',
      value: `${advancers ?? '--'} / ${decliners ?? '--'}`,
      hint: breadth.unchanged === null || breadth.unchanged === undefined ? '' : `平盘 ${breadth.unchanged}`,
    },
    {
      label: '成分覆盖',
      value: Number.isFinite(Number(coverage.coverage_pct)) ? `${formatNumber(coverage.coverage_pct)}%` : '--',
      hint: coverage.total_members ? `${coverage.covered_members ?? '--'} / ${coverage.total_members}` : '',
      klass: snapshot.insufficient_coverage ? ' warn' : '',
    },
    {
      label: '数据时点',
      value: formatDate(snapshot.snapshot_at || snapshot.as_of),
      hint: breadth.breadth_basis === 'computed_from_members' ? '宽度由成分行情计算' : breadth.breadth_basis === 'provider' ? '宽度由来源发布' : '',
    },
  ];
  element.innerHTML = cells.map((cell) => `<div class="board-metric${cell.klass || ''}"><span class="board-metric-label">${escapeHtml(cell.label)}</span><strong class="board-metric-value">${escapeHtml(cell.value)}</strong><span class="board-metric-hint">${escapeHtml(cell.hint || '')}</span></div>`).join('');
  element.hidden = false;
}

function boardMemberRow(direction, member) {
  const change = member.change_pct;
  const klass = !Number.isFinite(Number(change)) ? '' : Number(change) >= 0 ? 'up' : 'down';
  return `<tr><td>${escapeHtml(direction)}</td><td>${escapeHtml(member.code || member.symbol || '--')}</td><td>${escapeHtml(member.name || '--')}</td><td class="${klass}">${escapeHtml(formatNumber(change))}${Number.isFinite(Number(change)) ? '%' : ''}</td><td>${escapeHtml(formatNumber(member.close))}</td><td>${escapeHtml(formatCompactNumber(member.amount))}</td></tr>`;
}

function renderBoardMembers(members) {
  const wrap = $('#board-members');
  const body = $('#board-member-body');
  if (!wrap || !body) return;
  const leaders = Array.isArray(members?.leaders) ? members.leaders.slice(0, 5) : [];
  const laggards = Array.isArray(members?.laggards) ? members.laggards.slice(0, 5) : [];
  if (!leaders.length && !laggards.length) {
    wrap.hidden = true;
    body.innerHTML = '';
    return;
  }
  body.innerHTML = [
    ...leaders.map((item) => boardMemberRow('领涨', item)),
    ...laggards.map((item) => boardMemberRow('拖累', item)),
  ].join('');
  wrap.hidden = false;
}

function renderBoard() {
  const surface = $('#board-surface');
  if (!surface) return;
  const byTool = boardEvidence();
  const snapshot = byTool.get('get_board_snapshot') || byTool.get('get_board_breadth') || null;
  const resolution = byTool.get('resolve_board') || null;
  const members = byTool.get('get_board_members') || null;
  const context = marketContextFrom(byTool);
  if (!byTool.size) {
    surface.hidden = true;
    return;
  }
  surface.hidden = false;
  const label = $('#board-state');
  if (label) {
    label.textContent = snapshot ? (snapshot.insufficient_coverage ? '覆盖不足' : '已读取板块行情') : resolution ? '已解析板块' : '已读取市场时点';
  }
  renderBoardContext(context);
  renderBoardIdentity(snapshot || resolution);
  renderBoardMetrics(snapshot);
  renderBoardMembers(members);

  // Coverage, staleness and source-degradation warnings must never be hidden
  // behind the summary cards.
  const warningElement = $('#board-warnings');
  if (warningElement) {
    const warnings = [
      ...(Array.isArray(snapshot?.warnings) ? snapshot.warnings : []),
      ...(Array.isArray(members?.warnings) ? members.warnings : []),
      ...(Array.isArray(snapshot?.data_quality?.warnings) ? snapshot.data_quality.warnings : []),
    ];
    const unique = [...new Set(warnings.filter(Boolean))];
    warningElement.textContent = unique.join('；');
    warningElement.hidden = !unique.length;
  }
  const limitationElement = $('#board-limitations');
  if (limitationElement) {
    const limitations = Array.isArray(snapshot?.limitations) ? snapshot.limitations : [];
    const text = limitations.length ? limitations.join('；') : snapshot ? '不同平台的板块成分口径可能不同。' : '';
    limitationElement.textContent = text;
    limitationElement.hidden = !text;
  }
}

function evidenceObjects() {
  const rows = Array.isArray(state.run?.evidence) ? state.run.evidence.map((item) => ({ ...item })) : [];
  state.events.forEach((event) => {
    if (!['tool_completed', 'tool_failed'].includes(event.type)) return;
    const payload = event.payload || {};
    if (payload.ok === false || !payload.data) return;
    const data = isObject(payload.data) ? payload.data : {};
    rows.push({
      id: `event-${event.sequence}`,
      tool: payload.tool_call?.name || 'market tool',
      endpoint: data.path || data.endpoint || '',
      symbol: data.symbol || data.code || '',
      as_of: data.as_of || data.asOf || '',
      summary: data.summary || `${payload.tool_call?.name || '工具'} 返回公开数据`,
      content_sha256: data.content_sha256 || '',
    });
  });
  const unique = new Map();
  rows.forEach((row) => {
    const key = `${row.tool || ''}|${row.symbol || ''}|${row.as_of || ''}|${row.content_sha256 || row.summary || ''}`;
    if (!unique.has(key)) unique.set(key, row);
  });
  return [...unique.values()];
}

function renderEvidence() {
  const list = $('#evidence-list');
  const count = $('#evidence-count');
  if (!list || !count) return;
  const rows = evidenceObjects();
  count.textContent = String(rows.length);
  if (!rows.length) {
    list.innerHTML = '<div class="empty-state"><span class="empty-icon" aria-hidden="true">◇</span><span>成功的行情或筛选调用会留下证据摘要。</span></div>';
    return;
  }
  list.innerHTML = rows.map((row) => {
    const digest = row.content_sha256 ? ` · <code>${escapeHtml(String(row.content_sha256).slice(0, 12))}...</code>` : '';
    return `<article class="evidence-item"><div class="evidence-head"><strong>${escapeHtml(row.tool || '公开数据')}</strong><span class="muted">${escapeHtml(row.as_of || '时间待核验')}</span></div><p>${escapeHtml(row.summary || '已保存公开数据摘要')}</p><p>${escapeHtml(row.symbol || row.endpoint || '未指定标的')}${row.source ? ` · ${escapeHtml(row.source)}` : ''}${digest}</p></article>`;
  }).join('');
}

function normalizeChartPoints(history, indicators) {
  if (!marketHelpers) return { points: [], warnings: ['图表模块未加载。'], maCovered: 0 };
  return marketHelpers.mergeChartPoints(history, indicators);
}

function setChartState(label) {
  const element = $('#chart-state');
  if (element) element.textContent = label;
}

/** Chart-local data quality and partial-failure notes stay inside the chart. */
function setChartQuality(message) {
  const element = $('#chart-quality');
  if (!element) return;
  element.textContent = message || '';
  element.hidden = !message;
}

function setChartIdentity(target) {
  const symbol = String(target?.symbol || target?.code || '').trim();
  const code = String(target?.code || symbol).trim();
  const name = String(target?.name || '').trim();
  const title = $('#chart-symbol');
  if (title) title.textContent = symbol ? (name ? `${name} · ${code}` : symbol) : '尚未选择标的';
  const asOf = $('#chart-asof');
  if (asOf) asOf.textContent = symbol ? `${symbol} · 前复权日线` : '前复权日线';
  const refresh = $('#chart-refresh');
  if (refresh) refresh.disabled = !symbol;
}

function renderChartEmpty(message, stateLabel = '无数据') {
  const svg = $('#price-chart');
  const empty = $('#chart-empty');
  if (svg) {
    svg.hidden = true;
    svg.innerHTML = '';
  }
  if (empty) {
    empty.textContent = message;
    empty.hidden = false;
  }
  setChartState(stateLabel);
  setChartQuality('');
  const summary = $('#chart-summary');
  if (summary) {
    summary.innerHTML = '';
    summary.hidden = true;
  }
}

function renderChartSummary(indicators, points) {
  const summary = $('#chart-summary');
  if (!summary) return;
  const values = indicators?.summary || indicators?.features || {};
  const fields = [
    ['最新', values.latest_close ?? values.close ?? points.at(-1)?.close, ''],
    ['60日', values.period_return_pct ?? values.return_60d_pct, '%'],
    ['波动', values.volatility_annualized_pct ?? values.volatility_20d_pct, '%'],
  ];
  summary.innerHTML = fields.map(([label, value, suffix]) => `<span><strong>${label}</strong> ${escapeHtml(formatNumber(value))}${value === null || value === undefined ? '' : suffix}</span>`).join('');
  summary.hidden = false;
}

function linePath(points, key, x, y) {
  const commands = [];
  points.forEach((point, index) => {
    const value = point[key];
    if (!Number.isFinite(value)) return;
    commands.push(`${commands.length ? 'L' : 'M'} ${x(index).toFixed(2)} ${y(value).toFixed(2)}`);
  });
  return commands.join(' ');
}

function renderSvgChart(points) {
  const svg = $('#price-chart');
  const empty = $('#chart-empty');
  if (!svg || !empty) return;
  if (!points.length) {
    renderChartEmpty('没有可绘制的有效日线数据。', '无有效数据');
    return;
  }
  const width = 900;
  const height = 390;
  const left = 57;
  const right = 18;
  const top = 18;
  const priceBottom = 275;
  const volumeTop = 296;
  const volumeBottom = 344;
  const plotWidth = width - left - right;
  const step = plotWidth / Math.max(points.length, 1);
  const x = (index) => left + step * (index + .5);
  const rawHigh = Math.max(...points.map((point) => point.high).filter(Number.isFinite));
  const rawLow = Math.min(...points.map((point) => point.low).filter(Number.isFinite));
  const padding = Math.max((rawHigh - rawLow) * .07, Math.abs(rawHigh || 1) * .004, .01);
  const maxPrice = rawHigh + padding;
  const minPrice = rawLow - padding;
  const y = (value) => top + (maxPrice - value) / Math.max(maxPrice - minPrice, .000001) * (priceBottom - top);
  const maxVolume = Math.max(...points.map((point) => point.volume || 0), 1);
  const candleWidth = Math.max(2, Math.min(11, step * .64));
  const maStyles = [['ma5', '#d18b27'], ['ma10', '#7a5bb5'], ['ma20', '#2e8e70'], ['ma30', '#cf5f45'], ['ma60', '#3c73a9']];
  const grid = [0, .25, .5, .75, 1].map((fraction) => {
    const value = maxPrice - (maxPrice - minPrice) * fraction;
    const yPosition = top + (priceBottom - top) * fraction;
    return `<line x1="${left}" y1="${yPosition.toFixed(2)}" x2="${width - right}" y2="${yPosition.toFixed(2)}" stroke="#e4ebeb" stroke-width="1"/><text x="${left - 8}" y="${(yPosition + 4).toFixed(2)}" text-anchor="end" fill="#829095" font-size="10">${escapeXml(formatNumber(value))}</text>`;
  }).join('');
  const candles = points.map((point, index) => {
    const color = point.close >= point.open ? '#c84a53' : '#167c7d';
    const bodyTop = Math.min(y(point.open), y(point.close));
    const bodyHeight = Math.max(1.4, Math.abs(y(point.close) - y(point.open)));
    return `<line x1="${x(index).toFixed(2)}" y1="${y(point.high).toFixed(2)}" x2="${x(index).toFixed(2)}" y2="${y(point.low).toFixed(2)}" stroke="${color}" stroke-width="1"/><rect x="${(x(index) - candleWidth / 2).toFixed(2)}" y="${bodyTop.toFixed(2)}" width="${candleWidth.toFixed(2)}" height="${bodyHeight.toFixed(2)}" fill="${color}"/>`;
  }).join('');
  const volumes = points.map((point, index) => {
    if (!Number.isFinite(point.volume)) return '';
    const barHeight = Math.max(1, point.volume / maxVolume * (volumeBottom - volumeTop));
    const color = point.close >= point.open ? '#e6a4a8' : '#83c5bd';
    return `<rect x="${(x(index) - candleWidth / 2).toFixed(2)}" y="${(volumeBottom - barHeight).toFixed(2)}" width="${candleWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" fill="${color}" opacity=".8"/>`;
  }).join('');
  const mas = maStyles.map(([key, color]) => {
    const path = linePath(points, key, x, y);
    return path ? `<path d="${path}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>` : '';
  }).join('');
  const dateEvery = Math.max(1, Math.ceil(points.length / 5));
  const labels = points.map((point, index) => index % dateEvery === 0 || index === points.length - 1 ? `<text x="${x(index).toFixed(2)}" y="${height - 12}" text-anchor="middle" fill="#829095" font-size="10">${escapeXml(point.date.slice(5, 10))}</text>` : '').join('');
  svg.innerHTML = `<rect x="0" y="0" width="${width}" height="${height}" fill="#fbfcfc"/><text x="${left}" y="12" fill="#829095" font-size="10">价格</text><text x="${left}" y="289" fill="#829095" font-size="10">成交量</text>${grid}<line x1="${left}" y1="${volumeBottom}" x2="${width - right}" y2="${volumeBottom}" stroke="#dbe4e5" stroke-width="1"/>${volumes}${candles}${mas}${labels}`;
  svg.hidden = false;
  empty.hidden = true;
}

function selectedCandidateByKey(key) {
  return candidateObjects().find((candidate) => String(candidate.symbol || candidate.code) === key) || null;
}

/**
 * Load the chart for one security.  `options.manual` records that the user
 * chose it, which permanently disables automatic retargeting for this run.
 */
async function loadCandidateMarket(candidate, options = {}) {
  if (!candidate) return;
  const symbol = String(candidate.symbol || candidate.code || '').trim();
  if (!symbol) return;
  if (options.manual) state.chartSelectionMode = 'manual';
  state.selectedCandidate = candidate;
  renderCandidates();
  setChartIdentity(candidate);
  renderChartEmpty('正在读取行情与技术指标。', '加载中');
  const requestId = ++state.marketRequest;
  const encoded = encodeURIComponent(symbol);
  const [historyResult, indicatorResult] = await Promise.allSettled([
    getJson(`/api/v1/quotes/history/${encoded}?adjustment=qfq&limit=120`),
    getJson(`/api/v1/indicators/technical/${encoded}?adjustment=qfq&limit=120`),
  ]);
  if (requestId !== state.marketRequest) return;
  const history = historyResult.status === 'fulfilled' ? historyResult.value : null;
  const indicators = indicatorResult.status === 'fulfilled' ? indicatorResult.value : null;
  const historyError = historyResult.status === 'rejected' ? historyResult.reason : null;
  const indicatorError = indicatorResult.status === 'rejected' ? indicatorResult.reason : null;
  if (historyError && indicatorError) {
    renderChartEmpty(`行情读取失败：${errorMessage(historyError)}`, '读取失败');
    setChartQuality(`技术指标同时失败：${errorMessage(indicatorError)}`);
    setAlert(`无法读取 ${symbol} 的行情：${errorMessage(historyError)}`);
    return;
  }
  const merged = normalizeChartPoints(history, indicators);
  const notes = [
    ...merged.warnings,
    ...(Array.isArray(history?.data_quality?.warnings) ? history.data_quality.warnings : []),
    ...(Array.isArray(indicators?.data_quality?.warnings) ? indicators.data_quality.warnings : []),
  ];
  if (historyError) notes.push(`历史行情读取失败：${errorMessage(historyError)}`);
  if (indicatorError) notes.push(`均线读取失败：${errorMessage(indicatorError)}`);
  if (!merged.points.length) {
    if (historyError) {
      // Indicator points carry no real open/high/low, so no candle is drawn.
      renderChartEmpty('历史日线读取失败，未用指标点合成 K 线。', '部分可用');
      renderChartSummary(indicators, merged.points);
    } else {
      renderChartEmpty('接口返回了空数据，未绘制占位行情。', '无有效数据');
    }
    setChartQuality([...new Set(notes.filter(Boolean))].join('；'));
    return;
  }
  renderChartSummary(indicators, merged.points);
  renderSvgChart(merged.points);
  if (!indicatorError && merged.maCovered === 0) notes.push('本次未取得可叠加的均线。');
  const partial = Boolean(indicatorError) || merged.maCovered === 0;
  setChartState(`${partial ? '部分可用' : '已加载'} · ${merged.points.length} 个交易日`);
  setChartQuality([...new Set(notes.filter(Boolean))].join('；'));
  const asOf = history?.as_of || indicators?.as_of || merged.points.at(-1)?.date;
  $('#chart-asof').textContent = `${symbol} · 前复权 · ${asOf || '时间待核验'}`;
}

/**
 * Display the run's single security automatically.  Each `run_id + symbol`
 * loads at most once, and a manual candidate selection is never overridden.
 */
function maybeAutoLoadChart() {
  if (!marketHelpers || !state.runId || state.chartSelectionMode === 'manual') return;
  const target = marketHelpers.chartTargetFromRun(state.run, state.events);
  if (!target) return;
  const key = `${state.runId}:${target.symbol}`;
  if (state.chartAutoLoadKey === key) return;
  state.chartAutoLoadKey = key;
  setChartIdentity(target);
  setChartState('已识别');
  loadCandidateMarket(target);
}

function renderRecentRuns(items) {
  const list = $('#recent-runs');
  if (!list) return;
  const runs = Array.isArray(items) ? items : [];
  if (!runs.length) {
    list.innerHTML = '<div class="empty-state">暂无历史 run。</div>';
    return;
  }
  list.innerHTML = runs.slice(0, 8).map((run) => `<div class="recent-run"><button type="button" data-run-id="${escapeHtml(run.id || run.run_id)}" title="载入运行">${escapeHtml(String(run.question || '未命名问题'))}</button><span class="recent-run-meta">${escapeHtml(statusLabel(run.status))} · ${escapeHtml(formatDate(run.created_at).slice(0, 10))}</span></div>`).join('');
}

async function loadRecentRuns(options = {}) {
  try {
    const data = await getJson('/api/v1/runs?limit=20');
    renderRecentRuns(data.items || []);
    setConnection('online', 'API 已连接');
    const active = (data.items || []).find((run) => isActive(run.status));
    if (options.attachActive && !state.runId && active) await selectRun(active.id);
  } catch (error) {
    renderRecentRuns([]);
    if (!state.runId) setAlert(`无法读取最近运行：${errorMessage(error)}`);
  }
}

async function selectRun(runId) {
  if (!runId) return;
  resetRunState();
  state.runId = String(runId);
  setStreamState('读取运行');
  const record = await syncRun({ reconnect: true, closeWhenFinal: true });
  if (record) {
    sessionStorage.setItem('wolf.agent.run', state.runId);
    if (isActive(record.status)) openStream();
  }
}

document.querySelectorAll('.segment').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
$('#run-form')?.addEventListener('submit', startRun);
$('#cancel-button')?.addEventListener('click', cancelRun);
$('#refresh-runs')?.addEventListener('click', () => loadRecentRuns());
$('#chart-refresh')?.addEventListener('click', () => loadCandidateMarket(state.selectedCandidate));
$('#candidate-body')?.addEventListener('click', (event) => {
  const button = event.target.closest('.candidate-select');
  if (!button) return;
  const candidate = selectedCandidateByKey(button.dataset.symbol);
  if (candidate) loadCandidateMarket(candidate, { manual: true });
});
$('#recent-runs')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-run-id]');
  if (button) selectRun(button.dataset.runId);
});

setMode('auto');
renderRun();
renderTrace();
renderEvidence();
renderCandidates();
renderBoard();
setChartIdentity(null);
if (marketHelpers) renderChartEmpty(CHART_IDLE_HINT, '等待标的');
else renderChartEmpty('图表模块 agent-market.js 未加载，无法显示行情。', '读取失败');
const previousRun = sessionStorage.getItem('wolf.agent.run');
loadSkills();
loadRecentRuns({ attachActive: !previousRun });
if (previousRun) selectRun(previousRun);
