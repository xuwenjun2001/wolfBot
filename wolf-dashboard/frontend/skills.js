const $ = (selector) => document.querySelector(selector);
const state = { skills: [], loading: false };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[char]));
}

function formatDate(value) {
  if (!value) return '时间待核验';
  return String(value).replace('T', ' ').slice(0, 19);
}

function formatBytes(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return '--';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function errorMessage(error, fallback = '请求失败') {
  return error?.message || fallback;
}

async function getJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = { detail: text }; }
  }
  if (!response.ok) {
    const detail = data.detail && typeof data.detail === 'object' ? data.detail : {};
    const error = new Error(detail.message || data.detail || `HTTP ${response.status}`);
    error.code = detail.code || data.code || `HTTP_${response.status}`;
    error.status = response.status;
    throw error;
  }
  return data;
}

function setAlert(message) {
  const element = $('#global-alert');
  if (!element) return;
  element.textContent = message || '';
  element.hidden = !message;
}

function setConnection(kind, label) {
  const element = $('#connection-state');
  if (!element) return;
  element.className = `state-dot ${kind}`;
  element.innerHTML = `<span aria-hidden="true"></span>${escapeHtml(label)}`;
}

function renderLoading() {
  $('#skills-list').innerHTML = '<div class="loading-state"><span class="spinner" aria-hidden="true"></span>正在读取 Skill 列表...</div>';
}

function renderSkills() {
  const list = $('#skills-list');
  if (!list) return;
  const items = state.skills;
  const enabled = items.filter((skill) => skill.enabled === true || skill.enabled === 1).length;
  $('#enabled-count').textContent = String(enabled);
  if (!items.length) {
    list.innerHTML = '<div class="empty-state">还没有发现 Skill。可以安装一个本地技能包。</div>';
    return;
  }
  list.innerHTML = items.map((skill) => {
    const id = skill.id || skill.skill_id || '';
    const builtin = skill.builtin === true || skill.builtin === 1 || skill.source === 'builtin';
    const checked = skill.enabled === true || skill.enabled === 1;
    const digest = skill.content_sha256 || skill.archive_sha256 || '';
    const mobileMeta = `v${skill.version || '--'} · ${builtin ? '内置' : '本地上传'} · SHA ${digest ? `${digest.slice(0, 10)}...` : '--'} · ${formatDate(skill.installed_at)}`;
    return `<article class="skill-row" data-skill-id="${escapeHtml(id)}">
      <div class="skill-identity"><strong title="${escapeHtml(id)}">${escapeHtml(skill.name || id || '未命名 Skill')}</strong><p>${escapeHtml(skill.description || skill.scope || '没有描述')}</p><small class="skill-mobile-meta">${escapeHtml(mobileMeta)}</small></div>
      <div class="skill-source"><span class="skill-label">来源</span><span class="source-badge ${builtin ? 'builtin' : ''}">${builtin ? '内置' : '本地上传'}</span><span class="skill-value">v${escapeHtml(skill.version || '--')}</span></div>
      <div class="skill-integrity"><span class="skill-label">SHA-256</span><span class="skill-value" title="${escapeHtml(digest)}"><code>${escapeHtml(digest ? `${digest.slice(0, 16)}...` : '--')}</code></span><span class="skill-value">${escapeHtml(formatBytes(skill.archive_size))}</span></div>
      <div class="skill-install"><span class="skill-label">安装时间</span><span class="skill-value">${escapeHtml(formatDate(skill.installed_at))}</span><span class="skill-value">${escapeHtml(skill.archive_name || '仓库内置')}</span></div>
      <div class="skill-actions"><label class="switch" title="${checked ? '停用 Skill' : '启用 Skill'}"><input type="checkbox" data-action="toggle" ${checked ? 'checked' : ''} aria-label="${checked ? '停用' : '启用'} ${escapeHtml(id)}" /><span>${checked ? '启用' : '停用'}</span></label><button type="button" class="uninstall-button" data-action="uninstall" ${builtin ? 'disabled' : ''} title="${builtin ? '内置 Skill 不可卸载' : '卸载 Skill'}" aria-label="${builtin ? '内置 Skill 不可卸载' : `卸载 ${id}`}" >⌫</button></div>
      <details class="skill-details"><summary>查看 SKILL.md</summary><pre data-content>展开后读取...</pre></details>
    </article>`;
  }).join('');
}

async function loadSkills() {
  state.loading = true;
  renderLoading();
  try {
    const data = await getJson('/api/v1/skills');
    state.skills = Array.isArray(data.items) ? data.items : [];
    renderSkills();
    setConnection('online', 'API 已连接');
    setAlert('');
  } catch (error) {
    state.skills = [];
    $('#skills-list').innerHTML = '<div class="empty-state">Skill 列表暂时不可用。</div>';
    setConnection('offline', 'API 不可用');
    setAlert(`无法读取 Skill 列表：${errorMessage(error)}`);
  } finally {
    state.loading = false;
  }
}

function setUploadError(message) {
  const element = $('#upload-error');
  element.textContent = message || '';
  element.hidden = !message;
}

async function uploadSkill(event) {
  event.preventDefault();
  const file = $('#skill-file').files?.[0];
  if (!file) {
    setUploadError('请选择 ZIP、TGZ 或 TAR.GZ 技能包。');
    return;
  }
  setUploadError('');
  const button = $('#upload-button');
  const stateLabel = $('#upload-state');
  button.disabled = true;
  stateLabel.textContent = '校验并安装中';
  const form = new FormData();
  form.append('file', file, file.name);
  try {
    await getJson('/api/v1/skills/install', { method: 'POST', body: form });
    $('#skill-file').value = '';
    $('#file-label').textContent = '选择技能包';
    stateLabel.textContent = '安装完成';
    await loadSkills();
  } catch (error) {
    const detail = errorMessage(error);
    setUploadError(`安装失败：${detail}`);
    stateLabel.textContent = '安装失败';
  } finally {
    button.disabled = false;
  }
}

async function toggleSkill(row, input) {
  const id = row.dataset.skillId;
  input.disabled = true;
  try {
    await getJson(`/api/v1/skills/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: input.checked }) });
    const item = state.skills.find((skill) => String(skill.id || skill.skill_id) === String(id));
    if (item) item.enabled = input.checked;
    renderSkills();
    setAlert('');
  } catch (error) {
    input.checked = !input.checked;
    setAlert(`更新 ${id} 失败：${errorMessage(error)}`);
  } finally {
    input.disabled = false;
  }
}

async function uninstallSkill(row) {
  const id = row.dataset.skillId;
  const item = state.skills.find((skill) => String(skill.id || skill.skill_id) === String(id));
  if (item?.builtin || item?.source === 'builtin') {
    setAlert('内置 Skill 可以停用，但不能卸载。');
    return;
  }
  if (!window.confirm(`确定卸载 ${id}？`)) return;
  const button = row.querySelector('[data-action="uninstall"]');
  button.disabled = true;
  try {
    await getJson(`/api/v1/skills/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadSkills();
  } catch (error) {
    setAlert(`卸载 ${id} 失败：${errorMessage(error)}`);
    button.disabled = false;
  }
}

async function loadContent(row) {
  const id = row.dataset.skillId;
  const content = row.querySelector('[data-content]');
  if (!content || content.dataset.loaded) return;
  content.textContent = '读取中...';
  try {
    const data = await getJson(`/api/v1/skills/${encodeURIComponent(id)}/SKILL.md`);
    content.textContent = data.content || 'SKILL.md 为空。';
    content.dataset.loaded = 'true';
  } catch (error) {
    content.textContent = `读取失败：${errorMessage(error)}`;
  }
}

$('#skill-file')?.addEventListener('change', (event) => {
  const file = event.currentTarget.files?.[0];
  $('#file-label').textContent = file ? file.name : '选择技能包';
  setUploadError('');
});
$('#upload-form')?.addEventListener('submit', uploadSkill);
$('#refresh-skills')?.addEventListener('click', loadSkills);
$('#skills-list')?.addEventListener('change', (event) => {
  const input = event.target.closest('[data-action="toggle"]');
  const row = event.target.closest('.skill-row');
  if (input && row) toggleSkill(row, input);
});
$('#skills-list')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action="uninstall"]');
  const row = event.target.closest('.skill-row');
  if (button && row) uninstallSkill(row);
});
$('#skills-list')?.addEventListener('toggle', (event) => {
  const row = event.target.closest('.skill-row');
  if (row && event.target.open) loadContent(row);
}, true);

loadSkills();
