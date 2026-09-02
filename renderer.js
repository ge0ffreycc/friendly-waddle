// 渲染进程：每日计划逻辑 + 本地持久化 (localStorage)
const STORAGE_KEY = 'desTopPlans';
// 固定任务模板存储：{ templates: [{id, text}], lastAppliedDate: 'YYYY-MM-DD' }
const RECURRING_KEY = 'desTopPlansRecurring';

const taskInput = document.getElementById('taskInput');
const btnAdd = document.getElementById('btnAdd');
const taskList = document.getElementById('taskList');
const dateLabel = document.getElementById('dateLabel');
const progressEl = document.getElementById('progress');
const emptyEl = document.getElementById('empty');
const btnClose = document.getElementById('btnClose');
const btnPin = document.getElementById('btnPin');
const btnRecurring = document.getElementById('btnRecurring');
const recurringPanel = document.getElementById('recurringPanel');
const recurringOverlay = document.getElementById('recurringOverlay');
const recurringList = document.getElementById('recurringList');
const recurringInput = document.getElementById('recurringInput');
const recurringAdd = document.getElementById('recurringAdd');
const recurringClose = document.getElementById('recurringClose');
const recurringEmpty = document.getElementById('recurringEmpty');

// 当前选中日期，默认今天
let selectedDate = todayKey();

// 1) 迁移历史未完成任务到今天
migrateUnfinishedTasks();
// 2) 应用每日固定任务到今天（首次当天打开时追加，不重复）
applyRecurringToday();

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDateLabel(key) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const week = ['日', '一', '二', '三', '四', '五', '六'][date.getDay()];
  const today = todayKey();
  let prefix = '';
  if (key === today) prefix = '今天 · ';
  else if (key === prevKey(today)) prefix = '昨天 · ';
  else if (key === nextKey(today)) prefix = '明天 · ';
  return `${prefix}${m}月${d}日 周${week}`;
}

function prevKey(key) { return shiftDay(key, -1); }
function nextKey(key) { return shiftDay(key, 1); }
function shiftDay(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + n);
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// 读取所有计划数据
function loadAll() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch { return {}; }
}
function saveAll(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function getTasks(date) {
  const all = loadAll();
  return all[date] || [];
}
function setTasks(date, tasks) {
  const all = loadAll();
  all[date] = tasks;
  saveAll(all);
}

// 迁移历史未完成任务到今天
// 逻辑：遍历所有早于今天的日期，将其中 done=false 的任务移到今天，
// 并在任务上标记 originDate（来源日期），防止重复迁移
function migrateUnfinishedTasks() {
  const today = todayKey();
  const all = loadAll();
  const dates = Object.keys(all).sort();
  let hasChange = false;

  for (const date of dates) {
    if (date >= today) continue; // 只处理今天之前的日期
    const tasks = all[date];
    if (!Array.isArray(tasks) || tasks.length === 0) continue;

    const remaining = [];
    for (const task of tasks) {
      if (!task.done && !task.migrated) {
        // 未完成且未被迁移过 → 迁移到今天
        const migrated = {
          ...task,
          id: task.id + '_m' + Date.now().toString(36), // 新ID，避免冲突
          originDate: date,
          migrated: true,
          order: (all[today] || []).length // 追加到今日列表末尾
        };
        if (!all[today]) all[today] = [];
        all[today].push(migrated);
        hasChange = true;
      } else {
        remaining.push(task);
      }
    }
    if (remaining.length !== tasks.length) {
      all[date] = remaining;
      hasChange = true;
    }
  }

  if (hasChange) saveAll(all);
}

// 格式化来源日期标签（昨天/前天/X月X日）
function formatOriginTag(dateStr) {
  const today = todayKey();
  if (dateStr === prevKey(today)) return '昨天';
  if (dateStr === shiftDay(today, -2)) return '前天';
  const [, m, d] = dateStr.split('-').map(Number);
  return `${m}月${d}日`;
}

// ===== 每日固定任务 =====
// 读取固定任务模板
function loadRecurring() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECURRING_KEY) || 'null');
    if (raw && Array.isArray(raw.templates)) return raw;
  } catch {}
  return { templates: [], lastAppliedDate: '' };
}
function saveRecurring(data) {
  localStorage.setItem(RECURRING_KEY, JSON.stringify(data));
}

// 启动时把固定任务追加到今天（同一天不重复追加）
function applyRecurringToday() {
  const today = todayKey();
  const data = loadRecurring();
  if (!data.templates || data.templates.length === 0) {
    data.lastAppliedDate = today;
    saveRecurring(data);
    return;
  }
  // 当天已应用过 → 跳过，避免每次启动重复添加
  if (data.lastAppliedDate === today) return;

  const all = loadAll();
  const todayTasks = Array.isArray(all[today]) ? all[today] : [];
  const baseOrder = todayTasks.length ? Math.max(...todayTasks.map(t => t.order || 0)) + 1 : 0;

  data.templates.forEach((tpl, i) => {
    todayTasks.push({
      id: 'rec_' + tpl.id + '_' + today,
      text: tpl.text,
      done: false,
      order: baseOrder + i,
      recurring: true,         // 标记来自固定任务
      recurringId: tpl.id      // 关联模板 ID
    });
  });

  all[today] = todayTasks;
  saveAll(all);

  data.lastAppliedDate = today;
  saveRecurring(data);
}

// 渲染
function render() {
  dateLabel.textContent = formatDateLabel(selectedDate);
  const tasks = getTasks(selectedDate);
  taskList.innerHTML = '';

  if (tasks.length === 0) {
    emptyEl.hidden = false;
    taskList.hidden = true;
  } else {
    emptyEl.hidden = true;
    taskList.hidden = false;
    // 未完成在前，已完成在后
    tasks
      .sort((a, b) => (a.done === b.done ? a.order - b.order : a.done ? 1 : -1))
      .forEach(task => taskList.appendChild(renderTask(task)));
  }

  const done = tasks.filter(t => t.done).length;
  progressEl.textContent = `${done} / ${tasks.length}`;
}

function renderTask(task) {
  const li = document.createElement('li');
  li.className = 'task' + (task.done ? ' done' : '');
  li.dataset.id = task.id;

  // 复选框
  const check = document.createElement('div');
  check.className = 'check';
  check.innerHTML = '<svg viewBox="0 0 16 16" width="11" height="11"><path fill="#0a1a24" d="m6.2 11.2-3-3 .9-.9 2.1 2.1 5-5 .9.9z"/></svg>';
  check.addEventListener('click', () => toggle(task.id));

  // 文本 + 来源标签包装
  const content = document.createElement('div');
  content.className = 'task-content';

  // 文本（双击编辑）
  const text = document.createElement('div');
  text.className = 'text';
  text.textContent = task.text;
  text.addEventListener('dblclick', () => startEdit(li, task));
  content.appendChild(text);

  // 来源日期标签（迁移的任务）
  if (task.originDate) {
    const tag = document.createElement('span');
    tag.className = 'origin-tag';
    tag.textContent = formatOriginTag(task.originDate) + ' · 遗留';
    tag.title = `原计划日期：${task.originDate}`;
    content.appendChild(tag);
  }

  // 固定任务标签
  if (task.recurring) {
    const tag = document.createElement('span');
    tag.className = 'recurring-tag';
    tag.textContent = '固定';
    tag.title = '每日固定任务';
    content.appendChild(tag);
  }

  // 删除
  const del = document.createElement('button');
  del.className = 'del';
  del.title = '删除';
  del.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M4 4h8v1H8.5v8h-1V5H4z"/></svg>';
  del.addEventListener('click', () => remove(task.id));

  li.appendChild(check);
  li.appendChild(content);
  li.appendChild(del);
  return li;
}

function startEdit(li, task) {
  const content = li.querySelector('.task-content');
  const textEl = content.querySelector('.text');
  const originTag = content.querySelector('.origin-tag');
  const input = document.createElement('input');
  input.className = 'text-edit';
  input.value = task.text;
  input.maxLength = 80;
  // 替换 text 和 tag（如果有）为输入框
  content.innerHTML = '';
  content.appendChild(input);
  input.focus();
  input.select();

  const commit = () => {
    const v = input.value.trim();
    if (v) {
      updateText(task.id, v);
    }
    render();
  };
  input.addEventListener('blur', commit, { once: true });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.removeEventListener('blur', commit); commit(); }
    if (e.key === 'Escape') { render(); }
  });
}

// 操作
function addTask(text) {
  text = text.trim();
  if (!text) return;
  const tasks = getTasks(selectedDate);
  const order = tasks.length ? Math.max(...tasks.map(t => t.order)) + 1 : 0;
  tasks.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text, done: false, order });
  setTasks(selectedDate, tasks);
  render();
}

function toggle(id) {
  const tasks = getTasks(selectedDate);
  const t = tasks.find(x => x.id === id);
  if (t) { t.done = !t.done; setTasks(selectedDate, tasks); render(); }
}

function updateText(id, text) {
  const tasks = getTasks(selectedDate);
  const t = tasks.find(x => x.id === id);
  if (t) { t.text = text; setTasks(selectedDate, tasks); }
}

function remove(id) {
  let tasks = getTasks(selectedDate);
  tasks = tasks.filter(x => x.id !== id);
  setTasks(selectedDate, tasks);
  render();
}

// 事件绑定
btnAdd.addEventListener('click', () => {
  addTask(taskInput.value);
  taskInput.value = '';
  taskInput.focus();
});

taskInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { addTask(taskInput.value); taskInput.value = ''; }
});

btnClose.addEventListener('click', () => window.app.closeWindow());
btnPin.addEventListener('click', () => {
  window.app.toggleTop();
  btnPin.classList.toggle('active');
});

// ===== 每日固定任务管理面板 =====
function openRecurringPanel() {
  renderRecurring();
  recurringOverlay.hidden = false;
  btnRecurring.classList.add('active');
  recurringInput.focus();
}
function closeRecurringPanel() {
  recurringOverlay.hidden = true;
  btnRecurring.classList.remove('active');
}

function renderRecurring() {
  const { templates } = loadRecurring();
  recurringList.innerHTML = '';
  if (templates.length === 0) {
    recurringEmpty.hidden = false;
    recurringList.hidden = true;
  } else {
    recurringEmpty.hidden = true;
    recurringList.hidden = false;
    templates.forEach(tpl => recurringList.appendChild(renderRecurringItem(tpl)));
  }
}

function renderRecurringItem(tpl) {
  const li = document.createElement('li');
  li.className = 'task';
  li.dataset.id = tpl.id;

  // 占位对齐用（无复选框）
  const check = document.createElement('div');
  check.className = 'check';
  check.style.opacity = '0.35';
  check.style.cursor = 'default';
  check.innerHTML = '<svg viewBox="0 0 16 16" width="11" height="11"><path fill="#0a1a24" d="M4 8h8v1H4z"/></svg>';

  const content = document.createElement('div');
  content.className = 'task-content';

  const text = document.createElement('div');
  text.className = 'text';
  text.textContent = tpl.text;
  text.addEventListener('dblclick', () => startRecurringEdit(li, tpl));
  content.appendChild(text);

  // 固定标签（预览效果）
  const tag = document.createElement('span');
  tag.className = 'recurring-tag';
  tag.textContent = '固定';
  content.appendChild(tag);

  const del = document.createElement('button');
  del.className = 'del';
  del.title = '删除';
  del.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M4 4h8v1H8.5v8h-1V5H4z"/></svg>';
  del.addEventListener('click', () => removeRecurring(tpl.id));

  li.appendChild(check);
  li.appendChild(content);
  li.appendChild(del);
  return li;
}

function addRecurring(text) {
  text = text.trim();
  if (!text) return;
  const data = loadRecurring();
  const tpl = {
    id: 'rt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text
  };
  data.templates.push(tpl);
  saveRecurring(data);
  // 当天新增的模板立即追加到今日任务（防重复）
  appendRecurringToToday(tpl);
  renderRecurring();
}

// 把单个模板追加到今日任务（若今日已存在该模板实例则跳过）
function appendRecurringToToday(tpl) {
  const today = todayKey();
  const all = loadAll();
  const todayTasks = Array.isArray(all[today]) ? all[today] : [];
  // 防重复：今日已存在同 recurringId 的实例 → 跳过
  if (todayTasks.some(t => t.recurringId === tpl.id)) return;

  const order = todayTasks.length ? Math.max(...todayTasks.map(t => t.order || 0)) + 1 : 0;
  todayTasks.push({
    id: 'rec_' + tpl.id + '_' + today,
    text: tpl.text,
    done: false,
    order,
    recurring: true,
    recurringId: tpl.id
  });
  all[today] = todayTasks;
  saveAll(all);
  // 若当前正显示今天，刷新主列表
  if (selectedDate === today) render();
}

function removeRecurring(id) {
  const data = loadRecurring();
  data.templates = data.templates.filter(t => t.id !== id);
  saveRecurring(data);
  renderRecurring();
}

function updateRecurringText(id, text) {
  const data = loadRecurring();
  const t = data.templates.find(x => x.id === id);
  if (t) { t.text = text; saveRecurring(data); }
}

function startRecurringEdit(li, tpl) {
  const content = li.querySelector('.task-content');
  const input = document.createElement('input');
  input.className = 'text-edit';
  input.value = tpl.text;
  input.maxLength = 80;
  content.innerHTML = '';
  content.appendChild(input);
  input.focus();
  input.select();

  const commit = () => {
    const v = input.value.trim();
    if (v) updateRecurringText(tpl.id, v);
    renderRecurring();
  };
  input.addEventListener('blur', commit, { once: true });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.removeEventListener('blur', commit); commit(); }
    if (e.key === 'Escape') { renderRecurring(); }
  });
}

btnRecurring.addEventListener('click', openRecurringPanel);
recurringClose.addEventListener('click', closeRecurringPanel);
recurringOverlay.addEventListener('click', (e) => {
  // 点击遮罩空白处关闭，点击面板内部不关闭
  if (e.target === recurringOverlay) closeRecurringPanel();
});
recurringAdd.addEventListener('click', () => {
  addRecurring(recurringInput.value);
  recurringInput.value = '';
  recurringInput.focus();
});
recurringInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { addRecurring(recurringInput.value); recurringInput.value = ''; }
  if (e.key === 'Escape') { closeRecurringPanel(); }
});

// 初始渲染
render();
