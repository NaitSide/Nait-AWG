'use strict';

const allRows = Array.from(document.querySelectorAll('.gate-client-row'));
const tbody = document.getElementById('peerRows');
const search = document.getElementById('search');
const dropdown = document.getElementById('statusDropdown');
const statusButton = document.getElementById('statusButton');
const pageButtons = Array.from(document.querySelectorAll('[data-page-size]'));
const qrButton = document.getElementById('showQr');
const configButton = document.getElementById('downloadConfig');
const powerButton = document.getElementById('toggleAccess');
const deleteForm = document.getElementById('deleteForm');
const deleteButton = document.getElementById('deletePeer');
const selectionNote = document.getElementById('selectionNote');
let filter = 'all';
let pageSize = 10;
let page = 1;
let sortKey = '';
let sortDirection = 1;
let selectedRow = allRows.find(row => row.classList.contains('selected')) || null;
let filteredCount = allRows.length;
let accessRequestId = 0;
if (selectedRow) page = Math.floor(allRows.indexOf(selectedRow) / pageSize) + 1;

const fieldValidationPopover = document.createElement('span');
fieldValidationPopover.className = 'field-validation-popover';
fieldValidationPopover.setAttribute('role', 'alert');
fieldValidationPopover.hidden = true;

function hideFieldValidation() {
  fieldValidationPopover.hidden = true;
  fieldValidationPopover.remove();
}

function fieldValidationMessage(field) {
  if (field.validity.valueMissing) return 'Заполните это поле.';
  if (field.validity.tooShort) return `Минимальное количество символов: ${field.minLength}. Сейчас: ${field.value.length}.`;
  if (field.validity.patternMismatch) return 'Проверьте формат введённого значения.';
  return 'Проверьте введённое значение.';
}

document.addEventListener('invalid', event => {
  const field = event.target;
  if (!(field instanceof HTMLInputElement) && !(field instanceof HTMLTextAreaElement)) return;
  event.preventDefault();
  if (field.form && field !== field.form.querySelector(':invalid')) return;
  const anchor = field.closest('label');
  if (!anchor) return;
  hideFieldValidation();
  fieldValidationPopover.textContent = fieldValidationMessage(field);
  anchor.append(fieldValidationPopover);
  fieldValidationPopover.hidden = false;
  field.focus();
}, true);
document.addEventListener('input', hideFieldValidation);

function setPowerState(state, message = '', checking = false) {
  powerButton.dataset.state = checking ? '' : state || '';
  powerButton.classList.toggle('danger', state === 'on');
  powerButton.classList.toggle('recovery', state === 'off');
  powerButton.classList.toggle('checking', checking);
  powerButton.setAttribute('aria-busy', String(checking));
  powerButton.querySelector('.gate-state-label').textContent = state === 'on' ? 'OFF' : state === 'off' ? 'ON' : '—';
  powerButton.disabled = checking || !state;
  const title = checking ? message || 'Проверяем доступ на сервере…'
    : state === 'on' ? 'Отключить доступ' : state === 'off' ? 'Включить доступ' : message || 'Состояние доступа не подтверждено';
  powerButton.title = title;
  powerButton.setAttribute('aria-label', title);
}

const statusLabels = { active: 'Активен', inactive: 'Неактивен', never: 'Не подключался', disabled: 'Отключён', unknown: 'Неизвестно' };
function setRowStatus(row, status) {
  const value = Object.hasOwn(statusLabels, status) ? status : 'unknown';
  row.dataset.status = value;
  const pill = row.querySelector('.pill');
  pill.classList.toggle('live', value === 'active');
  pill.classList.toggle('off', value === 'disabled');
  pill.textContent = statusLabels[value];
}

async function loadAccess(row) {
  const requestId = ++accessRequestId;
  const preview = ['on', 'off'].includes(row.dataset.accessState) ? row.dataset.accessState : null;
  setPowerState(preview, 'Проверяем доступ на сервере…', true);
  try {
    const response = await fetch('/api/peers/' + encodeURIComponent(row.dataset.peerId) + '/access', { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || 'Не удалось проверить доступ.');
    if (requestId === accessRequestId && selectedRow === row) {
      row.dataset.accessState = payload.state;
      setPowerState(payload.state);
      if (payload.state === 'off') {
        setRowStatus(row, 'disabled');
        keepSelectedVisible();
      } else if (row.dataset.status === 'disabled') refreshLive({ render: false })
        .then(() => keepSelectedVisible())
        .catch(error => {
          console.error(error);
          if (selectedRow === row) { setRowStatus(row, 'unknown'); keepSelectedVisible(); }
        });
    }
  } catch (error) {
    if (requestId === accessRequestId && selectedRow === row) setPowerState(null, error.message);
  }
}

function selectRow(row) {
  allRows.forEach(item => {
    item.classList.toggle('selected', item === row);
    item.setAttribute('aria-selected', String(item === row));
  });
  selectedRow = row;
  const hasConfig = row.dataset.hasConfig === 'true';
  const canDelete = row.dataset.canDelete === 'true';
  qrButton.disabled = !hasConfig;
  qrButton.title = hasConfig ? 'Показать QR-код' : 'Недоступно: исходный конфиг этого клиента не хранится на сервере';
  configButton.classList.toggle('is-disabled', !hasConfig);
  configButton.href = hasConfig ? row.dataset.configUrl : '';
  configButton.title = hasConfig ? 'Скачать конфиг' : 'Недоступно: исходный конфиг этого клиента не хранится на сервере';
  configButton.setAttribute('aria-disabled', String(!hasConfig));
  deleteButton.disabled = !canDelete;
  deleteButton.title = canDelete ? 'Удалить клиента' : 'Недоступно: состояние клиента не подтверждено';
  deleteForm.action = canDelete ? row.dataset.deleteUrl : '';
  selectionNote.textContent = 'Выбран: ' + row.dataset.label;
  history.replaceState(null, '', '/panel?selected=' + encodeURIComponent(row.dataset.peerId));
  loadAccess(row);
}

function resetSelection() {
  allRows.forEach(row => {
    row.classList.remove('selected');
    row.setAttribute('aria-selected', 'false');
  });
  selectedRow = null;
  accessRequestId++;
  setPowerState(null);
  qrButton.disabled = true;
  configButton.classList.add('is-disabled');
  configButton.removeAttribute('href');
  deleteButton.disabled = true;
  deleteForm.removeAttribute('action');
  selectionNote.textContent = '';
  history.replaceState(null, '', '/panel');
}

function addressValue(address) {
  return String(address || '').split('/')[0].split('.').reduce((n, part) => (n * 256) + (Number(part) || 0), 0);
}
function sortValue(row) {
  if (sortKey === 'activity') return Number(row.dataset.lastHandshake) || 0;
  if (sortKey === 'address') return addressValue(row.dataset.address);
  if (sortKey === 'status') return row.dataset.status;
  return row.dataset.label.toLocaleLowerCase('ru');
}
function renderTable({ revealSelected = false } = {}) {
  const query = search.value.trim().toLocaleLowerCase('ru');
  const visible = allRows.filter(row =>
    (filter === 'all' || row.dataset.status === filter) &&
    (!query || (row.dataset.label + ' ' + row.dataset.address).toLocaleLowerCase('ru').includes(query))
  );
  if (sortKey) visible.sort((a, b) => {
    const left = sortValue(a), right = sortValue(b);
    return (typeof left === 'number' ? left - right : String(left).localeCompare(String(right), 'ru')) * sortDirection;
  });
  const pages = Math.max(1, Math.ceil(visible.length / pageSize));
  filteredCount = visible.length;
  if (revealSelected && selectedRow && visible.includes(selectedRow)) page = Math.floor(visible.indexOf(selectedRow) / pageSize) + 1;
  page = Math.min(page, pages);
  const start = (page - 1) * pageSize;
  if (selectedRow && (!visible.includes(selectedRow) || visible.indexOf(selectedRow) < start || visible.indexOf(selectedRow) >= start + pageSize)) resetSelection();
  visible.forEach((row, index) => {
    row.hidden = index < start || index >= start + pageSize;
    tbody.appendChild(row);
  });
  allRows.filter(row => !visible.includes(row)).forEach(row => { row.hidden = true; tbody.appendChild(row); });
  const empty = document.getElementById('filterEmpty');
  if (empty) empty.remove();
  if (!visible.length && allRows.length) {
    const row = document.createElement('tr');
    row.id = 'filterEmpty';
    row.innerHTML = '<td colspan="4">Пользователи не найдены.</td>';
    tbody.appendChild(row);
  }
  renderGatePagination(visible.length);
}

function setStatusFilter(value) {
  const button = Array.from(document.querySelectorAll('[data-status-filter]')).find(item => item.dataset.statusFilter === value);
  if (!button) return;
  filter = value;
  page = 1;
  document.querySelectorAll('[data-status-filter]').forEach(item => item.classList.toggle('selected', item === button));
  dropdown.querySelector('.cdrop-label').textContent = button.textContent;
  dropdown.classList.remove('open');
  statusButton.setAttribute('aria-expanded', 'false');
}

function keepSelectedVisible() {
  if (!selectedRow) return;
  if (filter !== 'all' && selectedRow.dataset.status !== filter) {
    setStatusFilter(selectedRow.dataset.status === 'disabled' ? 'disabled' : 'all');
  }
  renderTable({ revealSelected: true });
  selectedRow?.scrollIntoView({ block: 'nearest' });
}

function renderGatePagination(totalItems) {
  const pagination = document.getElementById('pagination');
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  page = Math.min(page, totalPages);
  if (totalItems <= pageSize) {
    pagination.innerHTML = '';
    return;
  }
  const pageButtons = Array.from({ length: totalPages }, (_, index) => {
    const number = index + 1;
    const active = number === page ? ' active' : '';
    return `<button type="button" class="${active.trim()}" data-gate-page="${number}" aria-label="Страница ${number}">${number}</button>`;
  }).join('');
  pagination.innerHTML = `
    <button type="button" data-gate-page-prev aria-label="Предыдущая страница" ${page === 1 ? 'disabled' : ''}><svg viewBox="0 0 24 24"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg></button>
    ${pageButtons}
    <button type="button" data-gate-page-next aria-label="Следующая страница" ${page === totalPages ? 'disabled' : ''}><svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg></button>
  `;
}

allRows.forEach(row => {
  row.addEventListener('click', event => {
    if (event.target.closest('.avatar-edit-btn, .gate-note-icon, .gate-status-button, .gate-config-info')) return;
    selectRow(row);
  });
  row.addEventListener('keydown', event => {
    if (event.target.closest('button')) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectRow(row); }
  });
  row.querySelector('.avatar-edit-btn').addEventListener('click', event => {
    event.stopPropagation();
    selectRow(row);
    openEdit(row);
  });
  row.querySelector('.gate-note-icon').addEventListener('click', event => event.stopPropagation());
  row.querySelector('.gate-status-button').addEventListener('click', event => {
    event.stopPropagation();
    selectRow(row);
    openUsage(row);
  });
  row.querySelector('.gate-config-info')?.addEventListener('click', event => {
    event.stopPropagation();
    selectRow(row);
    clientConfigRow = row;
    document.getElementById('clientConfigName').textContent = row.dataset.label;
    showModal('clientConfigModal');
  });
});
function notePreview(note) {
  const value = String(note || '').trim();
  return value.length <= 140 ? value : value.slice(0, 140).trimEnd() + '…';
}
let noteTooltip = null;
function hideNoteTooltip() {
  if (!noteTooltip) return;
  noteTooltip.classList.remove('open');
  noteTooltip.setAttribute('aria-hidden', 'true');
}
function showNoteTooltip(icon) {
  const note = icon?.dataset.note;
  if (!note) return;
  if (!noteTooltip) {
    noteTooltip = document.createElement('div');
    noteTooltip.className = 'gate-note-tooltip';
    noteTooltip.setAttribute('aria-hidden', 'true');
    document.body.appendChild(noteTooltip);
  }
  noteTooltip.textContent = note;
  noteTooltip.style.left = '0px';
  noteTooltip.style.top = '0px';
  noteTooltip.classList.add('open');
  noteTooltip.setAttribute('aria-hidden', 'false');
  const targetRect = icon.getBoundingClientRect();
  const tooltipRect = noteTooltip.getBoundingClientRect();
  const gap = 8, margin = 12, halfWidth = tooltipRect.width / 2;
  const left = Math.min(Math.max(targetRect.left + targetRect.width / 2, margin + halfWidth), window.innerWidth - margin - halfWidth);
  let top = targetRect.top - tooltipRect.height - gap;
  if (top < margin) top = targetRect.bottom + gap;
  noteTooltip.style.left = Math.round(left) + 'px';
  noteTooltip.style.top = Math.round(top) + 'px';
}
document.addEventListener('mouseover', event => {
  const icon = event.target.closest('.gate-note-icon');
  if (icon) showNoteTooltip(icon);
});
document.addEventListener('mouseout', event => {
  if (event.target.closest('.gate-note-icon')) hideNoteTooltip();
});
document.addEventListener('focusin', event => {
  const icon = event.target.closest('.gate-note-icon');
  if (icon) showNoteTooltip(icon);
});
document.addEventListener('focusout', event => {
  if (event.target.closest('.gate-note-icon')) hideNoteTooltip();
});
window.addEventListener('scroll', hideNoteTooltip, true);
window.addEventListener('resize', hideNoteTooltip);
if (selectedRow) selectRow(selectedRow);
search.addEventListener('input', () => { page = 1; renderTable(); });
statusButton.addEventListener('click', () => {
  const open = dropdown.classList.toggle('open');
  statusButton.setAttribute('aria-expanded', String(open));
});
document.querySelectorAll('[data-status-filter]').forEach(button => button.addEventListener('click', () => {
  setStatusFilter(button.dataset.statusFilter);
  renderTable();
}));
document.addEventListener('click', event => {
  if (!dropdown.contains(event.target)) { dropdown.classList.remove('open'); statusButton.setAttribute('aria-expanded', 'false'); }
});
pageButtons.forEach(button => button.addEventListener('click', () => {
  pageSize = Number(button.dataset.pageSize);
  page = 1;
  pageButtons.forEach(item => item.classList.toggle('active', item === button));
  resetSelection();
  renderTable();
}));
document.getElementById('pagination').addEventListener('click', event => {
  const pageButton = event.target.closest('[data-gate-page]');
  const prevButton = event.target.closest('[data-gate-page-prev]');
  const nextButton = event.target.closest('[data-gate-page-next]');
  if (!pageButton && !prevButton && !nextButton) return;
  const totalPages = Math.max(1, Math.ceil(filteredCount / pageSize));
  if (pageButton) page = Number(pageButton.dataset.gatePage) || 1;
  if (prevButton) page = Math.max(1, page - 1);
  if (nextButton) page = Math.min(totalPages, page + 1);
  resetSelection();
  renderTable();
});
const sortIconSvg = `<svg viewBox="0 0 12 16" aria-hidden="true" focusable="false">
  <path class="sort-neutral" d="M6 2.5 3.5 5h5L6 2.5ZM6 13.5 8.5 11h-5L6 13.5Z" fill="currentColor"/>
  <path class="sort-asc" d="M6 2.5 3.5 5h5L6 2.5Z" fill="currentColor"/>
  <path class="sort-desc" d="M6 13.5 8.5 11h-5L6 13.5Z" fill="currentColor"/>
</svg>`;
const sortHeaders = Array.from(document.querySelectorAll('[data-sort]')).map(button => {
  const header = button.closest('th');
  header.classList.add('sortable');
  button.querySelector('.sort-icon').innerHTML = sortIconSvg;
  header.addEventListener('click', () => {
    if (sortKey === button.dataset.sort) sortDirection *= -1;
    else { sortKey = button.dataset.sort; sortDirection = 1; }
    sortHeaders.forEach(item => {
      item.classList.remove('sorted', 'asc', 'desc');
      item.setAttribute('aria-sort', 'none');
    });
    header.classList.add('sorted', sortDirection === 1 ? 'asc' : 'desc');
    header.setAttribute('aria-sort', sortDirection === 1 ? 'ascending' : 'descending');
    page = 1;
    renderTable();
  });
  return header;
});

function showModal(id) {
  const modal = document.getElementById(id);
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  if (id === 'createModal') document.getElementById('clientLabel').focus();
  if (id === 'backupModal') document.getElementById('backupEncrypt').focus();
  if (id === 'restoreModal') document.getElementById('restoreFile').focus();
}
let qrObjectUrl = null;
let qrRequestId = 0;
let createBusy = false;
let createdPeer = null;
let editBusy = false;
let editingRow = null;
let clientConfigRow = null;
let clientConfigBusy = false;
let accessBusy = false;
let deleteBusy = false;
let deletingRow = null;
let backupBusy = false;
let restoreBusy = false;
let restoreBackupObject = null;
let restoreInspected = false;
let usageRequestId = 0;
let accessModalRow = null;
let accessModalTarget = null;
const createModal = document.getElementById('createModal');
const createForm = document.getElementById('createForm');
const createSubmit = document.getElementById('createSubmit');
const createMessage = document.getElementById('createMessage');
function finishCreate() {
  if (createdPeer?.id) window.location.assign('/panel?selected=' + encodeURIComponent(createdPeer.id));
}
function closeModal(modal) {
  if (modal.id === 'obfuscationModal' && modal.dataset.busy === 'true') return;
  if (modal.id === 'createModal' && createBusy) return;
  if (modal.id === 'createModal' && createdPeer) return finishCreate();
  if (modal.id === 'editModal' && editBusy) return;
  if (modal.id === 'accessModal' && accessBusy) return;
  if (modal.id === 'deleteModal' && deleteBusy) return;
  if (modal.id === 'clientConfigModal' && clientConfigBusy) return;
  if (modal.id === 'backupModal' && backupBusy) return;
  if (modal.id === 'restoreModal' && restoreBusy) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  if (modal.id === 'clientConfigModal') {
    clientConfigRow = null;
    document.getElementById('clientConfigForm').reset();
    document.getElementById('clientConfigForm').hidden = true;
    document.getElementById('clientConfigError').hidden = true;
    document.getElementById('openClientConfigImport').setAttribute('aria-expanded', 'false');
  }
  if (modal.id === 'deleteModal') deletingRow = null;
  if (modal.id === 'backupModal') {
    document.getElementById('backupForm').reset();
    document.getElementById('backupError').hidden = true;
    document.getElementById('backupPasswordFields').hidden = true;
    document.getElementById('backupPassword').required = false;
    document.getElementById('backupPasswordConfirm').required = false;
  }
  if (modal.id === 'restoreModal') resetRestoreForm();
  if (modal.id === 'clientDownloadModal') downloadPeer = null;
  if (modal.id === 'qrModal') {
    qrPeer = null;
    document.getElementById('copyQr').disabled = true;
    qrRequestId += 1;
    document.getElementById('qrImage').removeAttribute('src');
    if (qrObjectUrl) URL.revokeObjectURL(qrObjectUrl);
    qrObjectUrl = null;
  }
  if (modal.id === 'usageModal') usageRequestId++;
}
document.getElementById('openClientConfigImport').addEventListener('click', () => {
  const form = document.getElementById('clientConfigForm');
  form.hidden = false;
  document.getElementById('openClientConfigImport').setAttribute('aria-expanded', 'true');
  document.getElementById('clientConfigFile').focus();
});
document.getElementById('clientConfigForm').addEventListener('submit', async event => {
  event.preventDefault();
  const row = clientConfigRow;
  if (clientConfigBusy || !row || row.dataset.hasConfig === 'true') return;
  const fileInput = document.getElementById('clientConfigFile');
  const submit = document.getElementById('clientConfigSubmit');
  const errorBox = document.getElementById('clientConfigError');
  clientConfigBusy = true;
  fileInput.disabled = submit.disabled = true;
  submit.textContent = 'Проверяем…';
  errorBox.hidden = true;
  try {
    const file = fileInput.files?.[0];
    if (!file) throw new Error('Выберите исходный файл .conf.');
    if (file.size > 64 * 1024) throw new Error('Выберите конфиг одного клиента размером до 64 КБ.');
    const config = await file.text();
    if (!config.trim()) throw new Error('Выбранный файл пуст.');
    const response = await fetch('/api/peers/' + encodeURIComponent(row.dataset.peerId) + '/config/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ config })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || 'Не удалось импортировать конфиг.');
    row.dataset.hasConfig = 'true';
    row.querySelector('.gate-config-info')?.remove();
    if (selectedRow === row) selectRow(row);
    clientConfigBusy = false;
    closeModal(document.getElementById('clientConfigModal'));
  } catch (error) {
    errorBox.textContent = error.message || 'Не удалось импортировать конфиг.';
    errorBox.hidden = false;
  } finally {
    clientConfigBusy = false;
    fileInput.disabled = submit.disabled = false;
    submit.textContent = 'Проверить и импортировать';
  }
});

function renderUsageMonths(usage) {
  const chart = document.getElementById('usageMonths');
  const detail = document.getElementById('usageMonthDetail');
  const byMonth = new Map((usage.months || []).map(month => [month.month, month]));
  const today = new Date();
  const slots = Array.from({ length: 12 }, (_, index) => {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 11 + index, 1));
    const key = date.toISOString().slice(0, 7);
    const recorded = byMonth.get(key);
    return { date, key, recorded: Boolean(recorded),
      received: Math.max(0, Number(recorded?.receivedBytes) || 0),
      sent: Math.max(0, Number(recorded?.sentBytes) || 0) };
  });
  const largest = Math.max(1, ...slots.flatMap(month => [month.received, month.sent]));
  const monthShort = new Intl.DateTimeFormat('ru-RU', { month: 'short', timeZone: 'UTC' });
  const monthLong = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  chart.replaceChildren();
  let selectedButton = null;
  function selectMonth(month, button) {
    if (selectedButton) {
      selectedButton.classList.remove('selected');
      selectedButton.setAttribute('aria-pressed', 'false');
    }
    selectedButton = button;
    button.classList.add('selected');
    button.setAttribute('aria-pressed', 'true');
    detail.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = monthLong.format(month.date);
    detail.appendChild(title);
    const values = document.createElement('span');
    values.textContent = month.recorded
      ? '↓ ' + trafficBytes(month.received) + '   ↑ ' + trafficBytes(month.sent)
      : 'Помесячных данных нет';
    detail.appendChild(values);
  }
  const buttons = slots.map((month, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'usage-month';
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', monthLong.format(month.date) + ': ' + (month.recorded
      ? 'получено ' + trafficBytes(month.received) + ', отправлено ' + trafficBytes(month.sent)
      : 'помесячных данных нет'));
    if (!month.recorded) button.classList.add('empty');
    const bars = document.createElement('span');
    bars.className = 'usage-month-bars';
    for (const [direction, value] of [['received', month.received], ['sent', month.sent]]) {
      const bar = document.createElement('span');
      bar.className = 'usage-bar ' + direction;
      bar.style.height = value ? Math.max(4, Math.round(value / largest * 96)) + 'px' : '0';
      bars.appendChild(bar);
    }
    const label = document.createElement('span');
    label.className = 'usage-month-label';
    label.textContent = monthShort.format(month.date).replace('.', '');
    const year = document.createElement('span');
    year.className = 'usage-month-year';
    year.textContent = index === 0 || month.date.getUTCMonth() === 0 ? String(month.date.getUTCFullYear()) : '';
    button.append(bars, label, year);
    button.addEventListener('click', () => selectMonth(month, button));
    chart.appendChild(button);
    return button;
  });
  const latestRecorded = slots.reduce((index, month, current) => month.recorded ? current : index, -1);
  const initiallySelected = latestRecorded < 0 ? slots.length - 1 : latestRecorded;
  selectMonth(slots[initiallySelected], buttons[initiallySelected]);
}
async function openUsage(row) {
  const requestId = ++usageRequestId;
  const loading = document.getElementById('usageLoading');
  const error = document.getElementById('usageError');
  const content = document.getElementById('usageContent');
  document.getElementById('usageClient').textContent = row.dataset.label + ' · ' + row.dataset.address;
  loading.hidden = false;
  error.hidden = true;
  content.hidden = true;
  showModal('usageModal');
  try {
    const response = await fetch('/api/peers/' + encodeURIComponent(row.dataset.peerId) + '/usage', { cache: 'no-store' });
    const usage = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(usage.message || 'Не удалось получить статистику клиента.');
    if (requestId !== usageRequestId) return;
    document.getElementById('usageReceived').textContent = trafficBytes(usage.receivedBytes);
    document.getElementById('usageSent').textContent = trafficBytes(usage.sentBytes);
    const before = document.getElementById('usageBefore');
    before.hidden = !usage.beforeTrackingReceivedBytes && !usage.beforeTrackingSentBytes;
    before.textContent = 'До начала помесячного учёта: ↓ '
      + trafficBytes(usage.beforeTrackingReceivedBytes) + ' · ↑ ' + trafficBytes(usage.beforeTrackingSentBytes);
    renderUsageMonths(usage);
    loading.hidden = true;
    content.hidden = false;
  } catch (failure) {
    if (requestId !== usageRequestId) return;
    loading.hidden = true;
    error.textContent = failure.message || 'Не удалось получить статистику клиента.';
    error.hidden = false;
  }
}
function openEdit(row) {
  editingRow = row;
  document.getElementById('editName').textContent = row.dataset.label;
  document.getElementById('editAddress').textContent = row.dataset.address;
  document.getElementById('editTelegram').value = row.dataset.telegram || '';
  document.getElementById('editNote').value = row.dataset.note || '';
  document.getElementById('editError').hidden = true;
  showModal('editModal');
  document.getElementById('editNote').focus();
}
document.getElementById('editForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (editBusy || !editingRow) return;
  const submit = document.getElementById('editSubmit');
  const error = document.getElementById('editError');
  const note = document.getElementById('editNote').value;
  const telegram = document.getElementById('editTelegram').value;
  editBusy = true;
  submit.disabled = true;
  submit.textContent = 'Сохраняем...';
  error.hidden = true;
  try {
    const response = await fetch('/api/peers/' + encodeURIComponent(editingRow.dataset.peerId) + '/metadata', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note, telegram })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || 'Не удалось сохранить данные клиента.');
    editingRow.dataset.note = payload.note || '';
    editingRow.dataset.telegram = payload.telegram || '';
    const contactLine = editingRow.querySelector('.gate-contact-line');
    const contact = contactLine.querySelector('.gate-client-contact');
    contact.textContent = payload.telegram || '';
    contact.hidden = !contact.textContent;
    const icon = editingRow.querySelector('.gate-note-icon');
    icon.dataset.note = notePreview(payload.note);
    icon.hidden = !icon.dataset.note;
    contactLine.hidden = contact.hidden && icon.hidden && !contactLine.querySelector('.gate-client-handshake:not([hidden])');
    hideNoteTooltip();
    editBusy = false;
    closeModal(document.getElementById('editModal'));
  } catch (failure) {
    error.textContent = failure.message || 'Не удалось сохранить данные клиента.';
    error.hidden = false;
  } finally {
    editBusy = false;
    submit.disabled = false;
    submit.textContent = 'Сохранить';
  }
});
document.getElementById('openCreate').addEventListener('click', () => {
  createdPeer = null;
  createForm.reset();
  createModal.classList.remove('is-success');
  document.getElementById('createSuccess').hidden = true;
  createMessage.hidden = true;
  createMessage.classList.remove('error');
  document.getElementById('createModalTitle').textContent = 'Выдать доступ вручную';
  document.getElementById('createModalSubtitle').textContent = 'Новый клиент AmneziaWG';
  showModal('createModal');
});
document.getElementById('openBackup').addEventListener('click', () => showModal('backupModal'));
document.getElementById('openRestore').addEventListener('click', () => {
  resetRestoreForm();
  showModal('restoreModal');
});
document.getElementById('backupEncrypt').addEventListener('change', event => {
  const encrypted = event.target.checked;
  document.getElementById('backupPasswordFields').hidden = !encrypted;
  document.getElementById('backupPassword').required = encrypted;
  document.getElementById('backupPasswordConfirm').required = encrypted;
  document.getElementById('backupError').hidden = true;
  if (encrypted) document.getElementById('backupPassword').focus();
  else {
    document.getElementById('backupPassword').value = '';
    document.getElementById('backupPasswordConfirm').value = '';
  }
});
document.getElementById('backupForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (backupBusy) return;
  const password = document.getElementById('backupPassword');
  const confirmation = document.getElementById('backupPasswordConfirm');
  const error = document.getElementById('backupError');
  const submit = document.getElementById('backupSubmit');
  const encrypted = document.getElementById('backupEncrypt').checked;
  error.hidden = true;
  if (encrypted && password.value !== confirmation.value) {
    error.textContent = 'Пароли не совпадают.';
    error.hidden = false;
    confirmation.focus();
    return;
  }
  backupBusy = true;
  submit.disabled = true;
  const originalLabel = submit.innerHTML;
  submit.textContent = 'Создаём копию…';
  try {
    const response = await fetch('/api/backup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: encrypted ? password.value : null }), cache: 'no-store'
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.message || 'Не удалось создать резервную копию.');
    }
    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    const filename = /^attachment;\s*filename="?(nait-awg-backup-[A-Za-z0-9-]+\.json)"?/i.exec(disposition)?.[1]
      || 'nait-awg-backup.json';
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    backupBusy = false;
    closeModal(document.getElementById('backupModal'));
  } catch (failure) {
    error.textContent = failure.message || 'Не удалось создать резервную копию.';
    error.hidden = false;
  } finally {
    backupBusy = false;
    submit.disabled = false;
    submit.innerHTML = originalLabel;
  }
});

function resetRestoreInspection() {
  restoreBackupObject = null;
  restoreInspected = false;
  document.getElementById('restoreSummary').hidden = true;
  document.getElementById('restoreConfirm').checked = false;
  document.getElementById('restoreObfuscation').checked = false;
  document.getElementById('restoreProgress').hidden = true;
  document.getElementById('restoreForm').hidden = false;
  document.getElementById('restoreSubtitle').textContent = 'Сначала проверим файл и целевой сервер.';
  document.getElementById('restoreModalTitle').textContent = 'Перенести клиентов из копии';
  document.getElementById('restoreError').hidden = true;
  document.getElementById('restoreSubmit').textContent = 'Проверить копию';
}
function resetRestoreForm() {
  const form = document.getElementById('restoreForm');
  form.reset();
  document.getElementById('restoreFile').disabled = false;
  document.getElementById('restorePassword').disabled = false;
  resetRestoreInspection();
}
document.getElementById('restoreFile').addEventListener('change', resetRestoreInspection);
document.getElementById('restorePassword').addEventListener('input', resetRestoreInspection);
document.getElementById('restoreForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (restoreBusy) return;
  const fileInput = document.getElementById('restoreFile');
  const passwordInput = document.getElementById('restorePassword');
  const confirmInput = document.getElementById('restoreConfirm');
  const error = document.getElementById('restoreError');
  const submit = document.getElementById('restoreSubmit');
  error.hidden = true;
  restoreBusy = true;
  submit.disabled = true;
  try {
    if (!restoreInspected) {
      const file = fileInput.files?.[0];
      if (!file) throw new Error('Выберите файл резервной копии.');
      if (file.size > 35 * 1024 * 1024) throw new Error('Файл резервной копии слишком большой.');
      submit.textContent = 'Проверяем…';
      try { restoreBackupObject = JSON.parse(await file.text()); }
      catch { throw new Error('Файл не является корректной резервной копией JSON.'); }
      const response = await fetch('/api/restore/inspect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
        body: JSON.stringify({ backup: restoreBackupObject, passphrase: passwordInput.value || null })
      });
      const summary = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(summary.message || 'Не удалось проверить резервную копию.');
      document.getElementById('restoreCreatedAt').textContent = new Date(summary.createdAt).toLocaleString('ru-RU');
      document.getElementById('restoreClients').textContent = String(summary.clientsCount);
      document.getElementById('restorePeers').textContent = String(summary.peersCount);
      document.getElementById('restoreEndpoint').textContent = summary.sourceEndpoint || '—';
      document.getElementById('restoreTargetEndpoint').textContent = summary.targetEndpoint || '—';
      document.getElementById('restoreObfuscation').disabled = !summary.obfuscationAvailable;
      document.getElementById('restoreSummary').hidden = false;
      fileInput.disabled = true;
      passwordInput.disabled = true;
      restoreInspected = true;
      submit.textContent = 'Восстановить';
      confirmInput.focus();
      return;
    }
    if (!confirmInput.checked) {
      throw new Error('Подтвердите замену текущих данных.');
    }
    submit.textContent = 'Переносим…';
    document.getElementById('restoreForm').hidden = true;
    document.getElementById('restoreProgress').hidden = false;
    document.getElementById('restoreModalTitle').textContent = 'Переносим клиентов';
    document.getElementById('restoreSubtitle').textContent = 'Создаём новые ключи и конфиги под этот сервер.';
    const response = await fetch('/api/restore', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ backup: restoreBackupObject, passphrase: passwordInput.value || null,
        confirmed: true, restoreObfuscation: document.getElementById('restoreObfuscation').checked })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.message || 'Не удалось восстановить резервную копию.');
    window.location.assign('/panel?restored=1');
  } catch (failure) {
    document.getElementById('restoreProgress').hidden = true;
    document.getElementById('restoreForm').hidden = false;
    document.getElementById('restoreModalTitle').textContent = 'Перенести клиентов из копии';
    document.getElementById('restoreSubtitle').textContent = 'Исправьте ошибку и повторите попытку.';
    error.textContent = failure.message || 'Не удалось восстановить резервную копию.';
    error.hidden = false;
  } finally {
    restoreBusy = false;
    submit.disabled = false;
    submit.textContent = restoreInspected ? 'Восстановить' : 'Проверить копию';
  }
});
createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (createBusy || createdPeer) return;
  const label = document.getElementById('clientLabel').value.trim();
  if (!label) return;
  createBusy = true;
  createSubmit.disabled = true;
  createSubmit.textContent = 'Создаём доступ...';
  document.getElementById('clientLabel').disabled = true;
  createMessage.hidden = false;
  createMessage.classList.remove('error');
  createMessage.textContent = 'Создаём VPN-клиента...';
  try {
    const response = await fetch('/api/peers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({label})
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || 'Не удалось создать доступ.');
    if (!payload.id) throw new Error('Сервер не вернул идентификатор нового доступа. Обновите список.');
    createdPeer = payload;
    document.getElementById('createModalTitle').textContent = 'VPN-клиент создан';
    document.getElementById('createModalSubtitle').textContent = '';
    document.getElementById('createdName').textContent = payload.label || label;
    document.getElementById('createdAddress').textContent = payload.address || '—';
    document.getElementById('createdConfig').href = '/api/peers/' + encodeURIComponent(payload.id) + '/config';
    createMessage.hidden = true;
    document.getElementById('createSuccess').hidden = false;
    createModal.classList.add('is-success');
  } catch (error) {
    createMessage.hidden = false;
    createMessage.classList.add('error');
    createMessage.textContent = error.message || 'Не удалось создать доступ. Проверьте список перед повтором.';
  } finally {
    createBusy = false;
    createSubmit.disabled = false;
    createSubmit.textContent = 'Создать доступ';
    document.getElementById('clientLabel').disabled = false;
  }
});
document.getElementById('createdDone').addEventListener('click', finishCreate);
document.getElementById('createdQr').addEventListener('click', () => {
  if (!createdPeer?.id) return;
  openQr({ id: createdPeer.id, label: createdPeer.label, qrUrl: '/api/peers/' + encodeURIComponent(createdPeer.id) + '/qr' });
});
qrButton.addEventListener('click', () => {
  if (!selectedRow || selectedRow.dataset.hasConfig !== 'true') return;
  openQr({ id: selectedRow.dataset.peerId, label: selectedRow.dataset.label, qrUrl: selectedRow.dataset.qrUrl });
});
const clientFormats = {
  awg: { title: 'AmneziaWG', extension: 'conf', url: 'https://docs.amnezia.org/ru/documentation/instructions/use-amneziawg-app/',
    instruction: 'Установите AmneziaWG. Добавьте туннель из скачанного файла .conf или отсканируйте QR в приложении. Затем включите подключение.' },
  vpn: { title: 'AmneziaVPN', extension: 'vpn', url: 'https://amnezia.org/downloads',
    instruction: 'Установите AmneziaVPN. Добавьте подключение из скачанного файла .vpn, затем включите VPN.' }
};
let qrPeer = null;
let qrFormat = 'awg';
let downloadPeer = null;
let downloadFormat = 'awg';
let qrCopyBusy = false;

function shareInstructions(kind, format) {
  const prefix = kind === 'qr' ? 'qr' : 'clientDownload';
  const info = clientFormats[format];
  document.querySelectorAll(`[data-share-modal="${kind}"]`).forEach(button => {
    const selected = button.dataset.shareFormat === format;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  document.getElementById(prefix + 'Instruction').textContent = info.instruction;
  const appLink = document.getElementById(prefix + 'AppLink');
  appLink.href = info.url;
  appLink.textContent = format === 'awg' ? 'Приложение и инструкция ↗' : 'Скачать приложение ↗';
  document.getElementById(prefix + 'ShareStatus').textContent = '';
}

function openClientDownload(peer) {
  downloadPeer = peer;
  downloadFormat = 'awg';
  document.getElementById('clientDownloadName').textContent = peer.label;
  selectDownloadFormat('awg');
  showModal('clientDownloadModal');
}
function selectDownloadFormat(format) {
  if (!downloadPeer) return;
  downloadFormat = format;
  shareInstructions('download', format);
  const link = document.getElementById('clientDownloadFile');
  link.href = '/api/peers/' + encodeURIComponent(downloadPeer.id) + '/config' + (format === 'vpn' ? '?format=amneziavpn' : '');
  link.textContent = 'Скачать .' + clientFormats[format].extension;
}
configButton.addEventListener('click', event => {
  event.preventDefault();
  if (!selectedRow || selectedRow.dataset.hasConfig !== 'true') return;
  openClientDownload({ id: selectedRow.dataset.peerId, label: selectedRow.dataset.label });
});
document.getElementById('createdConfig').addEventListener('click', event => {
  event.preventDefault();
  if (createdPeer?.id) openClientDownload({ id: createdPeer.id, label: createdPeer.label });
});
document.querySelectorAll('[data-share-format]').forEach(button => {
  button.addEventListener('click', () => {
    if (button.dataset.shareModal === 'qr') selectQrFormat(button.dataset.shareFormat);
    else selectDownloadFormat(button.dataset.shareFormat);
  });
  button.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = Array.from(document.querySelectorAll(`[data-share-modal="${button.dataset.shareModal}"]`));
    const index = tabs.indexOf(button);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].click(); tabs[next].focus();
  });
});
for (const [kind, prefix] of [['qr', 'qr'], ['download', 'clientDownload']]) {
  document.getElementById(prefix + 'CopyInstruction').addEventListener('click', async () => {
    const format = kind === 'qr' ? qrFormat : downloadFormat;
    const info = clientFormats[format];
    const status = document.getElementById(prefix + 'ShareStatus');
    try {
      const text = `${info.title}\n${info.instruction}\n${info.url}`;
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        // Text-only fallback for self-hosted panels accessed over plain HTTP.
        const field = document.createElement('textarea');
        field.value = text; field.readOnly = true;
        field.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(field); field.select();
        try { if (!document.execCommand('copy')) throw new Error(); }
        finally { field.remove(); }
      }
      status.textContent = 'Инструкция скопирована.';
    } catch { status.textContent = 'Браузер не разрешил копирование. Можно выделить текст инструкции вручную.'; }
  });
}

async function openQr(peer) {
  qrPeer = peer;
  document.getElementById('qrLabel').textContent = peer.label;
  showModal('qrModal');
  await selectQrFormat('awg');
}
async function selectQrFormat(format) {
  if (!qrPeer) return;
  qrFormat = format;
  shareInstructions('qr', format);
  const requestId = ++qrRequestId;
  const peer = qrPeer;
  const image = document.getElementById('qrImage');
  const status = document.getElementById('qrStatus');
  const link = document.getElementById('downloadQr');
  const copy = document.getElementById('copyQr');
  image.hidden = true; image.removeAttribute('src');
  if (qrObjectUrl) URL.revokeObjectURL(qrObjectUrl);
  qrObjectUrl = null;
  copy.disabled = true;
  link.removeAttribute('href'); link.setAttribute('aria-disabled', 'true');
  status.hidden = false;
  const pending = format === 'vpn';
  document.getElementById('qrActions').hidden = pending;
  document.getElementById('qrMultipartHint').hidden = !pending;
  document.getElementById('qrUseFile').hidden = !pending;
  if (pending) { status.textContent = 'QR для AmneziaVPN пока не включён. Подключение уже можно скачать в файле .vpn.'; return; }
  status.textContent = 'Загрузка QR…';
  link.download = 'Nait-AWG-' + peer.id.slice(0, 12) + '-QR.svg';
  try {
    const response = await fetch(peer.qrUrl);
    if (!response.ok) throw new Error('Не удалось загрузить QR-код.');
    const blob = await response.blob();
    if (requestId !== qrRequestId) return;
    qrObjectUrl = URL.createObjectURL(blob);
    image.onload = () => {
      if (requestId !== qrRequestId) return;
      image.hidden = false; status.hidden = true; copy.disabled = qrCopyBusy;
      link.href = qrObjectUrl; link.removeAttribute('aria-disabled');
    };
    image.onerror = () => { if (requestId === qrRequestId) status.textContent = 'Не удалось показать QR-код.'; };
    image.src = qrObjectUrl;
  } catch (error) { if (requestId === qrRequestId) status.textContent = error.message || 'Не удалось загрузить QR-код.'; }
}
document.getElementById('qrUseFile').addEventListener('click', () => {
  if (!qrPeer) return;
  const peer = qrPeer;
  closeModal(document.getElementById('qrModal'));
  openClientDownload(peer);
  selectDownloadFormat('vpn');
});
document.getElementById('copyQr').addEventListener('click', async () => {
  const image = document.getElementById('qrImage');
  if (qrFormat !== 'awg' || image.hidden || !qrObjectUrl || qrCopyBusy) return;
  const requestId = qrRequestId;
  const status = document.getElementById('qrShareStatus');
  const button = document.getElementById('copyQr');
  qrCopyBusy = true; button.disabled = true;
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1024;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1024, 1024);
    ctx.drawImage(image, 0, 0, 1024, 1024);
    const png = new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error()), 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    if (requestId === qrRequestId) status.textContent = 'QR скопирован как картинка.';
  } catch {
    if (requestId === qrRequestId) status.textContent = window.isSecureContext === false
      ? 'Для копирования картинки откройте панель по HTTPS. По HTTP используйте «Скачать QR».'
      : 'Браузер не разрешил копирование картинки. Используйте «Скачать QR».';
  }
  finally {
    qrCopyBusy = false;
    button.disabled = qrFormat !== 'awg' || document.getElementById('qrImage').hidden;
  }
});

document.querySelectorAll('[data-close-modal]').forEach(button => button.addEventListener('click', () => closeModal(button.closest('.modal-backdrop'))));
document.querySelectorAll('.modal-backdrop').forEach(modal => modal.addEventListener('click', event => { if (event.target === modal) closeModal(modal); }));
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const topModal = document.querySelector('#deleteModal.open') || document.querySelector('#clientConfigModal.open') || document.querySelector('#usageModal.open') || document.querySelector('#restoreModal.open') || document.querySelector('#backupModal.open') || document.querySelector('#accessModal.open') || document.querySelector('#clientDownloadModal.open') || document.querySelector('#qrModal.open') || document.querySelector('#editModal.open') || document.querySelector('#createModal.open');
  if (topModal) closeModal(topModal);
});
deleteForm.addEventListener('submit', event => {
  event.preventDefault();
  if (!selectedRow || selectedRow.dataset.canDelete !== 'true' || deleteBusy) return;
  deletingRow = selectedRow;
  document.getElementById('deleteName').textContent = deletingRow.dataset.label;
  document.getElementById('deleteTelegram').textContent = deletingRow.dataset.telegram || '—';
  document.getElementById('deleteAddress').textContent = deletingRow.dataset.address;
  document.getElementById('deleteNote').textContent = deletingRow.dataset.note || '—';
  document.getElementById('deleteError').hidden = true;
  document.getElementById('deleteConsent').setAttribute('aria-pressed', 'false');
  document.getElementById('deleteConsent').disabled = false;
  document.getElementById('deleteConfirm').disabled = true;
  document.getElementById('deleteConfirm').textContent = 'Удалить клиента';
  document.getElementById('deleteModal').classList.remove('is-confirmed');
  showModal('deleteModal');
  document.getElementById('deleteConsent').focus();
});
document.getElementById('deleteConsent').addEventListener('click', () => {
  if (deleteBusy || !deletingRow) return;
  const consent = document.getElementById('deleteConsent');
  const confirmed = consent.getAttribute('aria-pressed') !== 'true';
  consent.setAttribute('aria-pressed', String(confirmed));
  document.getElementById('deleteModal').classList.toggle('is-confirmed', confirmed);
  document.getElementById('deleteConfirm').disabled = !confirmed;
});
document.getElementById('deleteConfirm').addEventListener('click', async () => {
  const row = deletingRow;
  const consent = document.getElementById('deleteConsent');
  if (!row || deleteBusy || consent.getAttribute('aria-pressed') !== 'true') return;
  deleteBusy = true;
  const button = document.getElementById('deleteConfirm');
  const errorBox = document.getElementById('deleteError');
  button.disabled = consent.disabled = true;
  button.textContent = 'Удаляем…';
  errorBox.hidden = true;
  try {
    const response = await fetch('/api/peers/' + encodeURIComponent(row.dataset.peerId), { method: 'DELETE' });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.message || 'Не удалось удалить клиента.');
    }
    window.location.assign('/panel');
  } catch (error) {
    errorBox.textContent = error.message || 'Связь прервалась. Проверьте список клиентов перед повтором.';
    errorBox.hidden = false;
    deleteBusy = false;
    consent.disabled = false;
    consent.setAttribute('aria-pressed', 'false');
    document.getElementById('deleteModal').classList.remove('is-confirmed');
    button.disabled = true;
    button.textContent = 'Удалить клиента';
  }
});
powerButton.addEventListener('click', () => {
  const row = selectedRow;
  const state = powerButton.dataset.state;
  if (!row || !['on', 'off'].includes(state)) return;
  accessModalRow = row;
  accessModalTarget = state === 'off';
  const enabled = accessModalTarget;
  document.getElementById('accessModalTitle').textContent = enabled ? 'Включить VPN-клиента?' : 'Отключить VPN-клиента?';
  document.getElementById('accessModalText').textContent = enabled
    ? 'Доступ по прежнему адресу будет восстановлен. Перескачивать конфиг не нужно.'
    : 'VPN-трафик клиента перестанет проходить. Конфиг и запись для обратного включения сохранятся.';
  document.getElementById('accessName').textContent = row.dataset.label;
  document.getElementById('accessTelegram').textContent = row.dataset.telegram || '—';
  document.getElementById('accessAddress').textContent = row.dataset.address;
  document.getElementById('accessNote').textContent = row.dataset.note || '—';
  const error = document.getElementById('accessError');
  error.textContent = '';
  error.hidden = true;
  const button = document.getElementById('accessConfirm');
  button.disabled = false;
  button.textContent = enabled ? 'Включить' : 'Отключить';
  button.classList.toggle('primary', enabled);
  button.classList.toggle('danger', !enabled);
  showModal('accessModal');
});
document.getElementById('accessConfirm').addEventListener('click', async () => {
  const row = accessModalRow;
  const enabled = accessModalTarget;
  if (!row || accessBusy || typeof enabled !== 'boolean') return;
  accessBusy = true;
  const button = document.getElementById('accessConfirm');
  const errorBox = document.getElementById('accessError');
  button.disabled = true;
  button.textContent = enabled ? 'Включаем…' : 'Отключаем…';
  errorBox.hidden = true;
  const requestId = ++accessRequestId;
  setPowerState(enabled ? 'off' : 'on', 'Переключаем и проверяем доступ…', true);
  let responseReceived = false;
  try {
    const response = await fetch('/api/peers/' + encodeURIComponent(row.dataset.peerId) + '/access', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    responseReceived = true;
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || 'Состояние доступа не подтверждено.');
    const check = await fetch('/api/peers/' + encodeURIComponent(row.dataset.peerId) + '/access', { cache: 'no-store' });
    const verified = await check.json();
    if (!check.ok || verified.state !== (enabled ? 'on' : 'off')) {
      throw new Error('Повторная проверка доступа не подтвердила переключение.');
    }
    if (requestId === accessRequestId && selectedRow === row) {
      row.dataset.accessState = verified.state;
      setPowerState(verified.state);
      if (verified.state === 'off') {
        setRowStatus(row, 'disabled');
        keepSelectedVisible();
      } else {
        try {
          await refreshLive({ render: false });
        } catch (error) {
          setRowStatus(row, 'unknown');
          console.error(error);
        }
        keepSelectedVisible();
      }
    }
    accessBusy = false;
    closeModal(document.getElementById('accessModal'));
  } catch (error) {
    errorBox.textContent = responseReceived
      ? (error.message || 'Состояние доступа не подтверждено.')
      : 'Связь прервалась. Результат не подтверждён. Закройте окно и проверьте состояние перед повтором.';
    errorBox.hidden = false;
    if (requestId === accessRequestId && selectedRow === row) loadAccess(row);
  } finally {
    accessBusy = false;
    button.textContent = enabled ? 'Включить' : 'Отключить';
  }
});

const adminAccessCard = document.getElementById('adminAccessCard');
const adminAccessToggle = document.getElementById('adminAccessToggle');
const adminPasswordForm = document.getElementById('adminPasswordForm');
const adminPasswordRequirement = document.getElementById('adminPasswordRequirement');
const adminPasswordFields = [
  document.getElementById('adminAccessLogin'),
  document.getElementById('adminCurrentPassword'),
  document.getElementById('adminNewPassword'),
  document.getElementById('adminRepeatPassword')
];

function setAdminPasswordStatus(message, type = '') {
  const status = document.getElementById('adminPasswordStatus');
  status.textContent = message;
  status.className = `admin-access-status${type ? ` ${type}` : ''}`;
}

function adminPasswordIsStrong(password) {
  return password.length >= 12 && password.length <= 256
    && /^[a-zA-Z0-9@#%^*_.!+\-]+$/.test(password)
    && /[a-z]/.test(password) && /[A-Z]/.test(password)
    && /[0-9]/.test(password) && /[@#%^*_.!+\-]/.test(password);
}

function showAdminPasswordRequirement(show) {
  if (show) hideFieldValidation();
  adminPasswordRequirement.hidden = !show;
  document.getElementById('adminNewPassword').setAttribute('aria-invalid', String(show));
}

function setAdminAccessEditing(editing) {
  adminAccessCard.classList.toggle('editing', editing);
  adminAccessToggle.setAttribute('aria-pressed', String(editing));
  document.getElementById('adminAccessMode').textContent = editing ? 'Edit mode' : 'Read-only';
  adminPasswordFields.forEach(input => { input.disabled = !editing; });
  if (!editing) adminPasswordFields.forEach(input => { input.value = input.id === 'adminAccessLogin' ? input.defaultValue : ''; });
  showAdminPasswordRequirement(false);
  setAdminPasswordStatus('');
  if (editing) document.getElementById('adminCurrentPassword').focus();
}

adminAccessToggle.addEventListener('click', () => {
  setAdminAccessEditing(adminAccessToggle.getAttribute('aria-pressed') !== 'true');
});

document.getElementById('adminNewPassword').addEventListener('input', () => showAdminPasswordRequirement(false));

adminPasswordForm.addEventListener('submit', async event => {
  event.preventDefault();
  const currentPassword = document.getElementById('adminCurrentPassword');
  const newPassword = document.getElementById('adminNewPassword');
  const repeatPassword = document.getElementById('adminRepeatPassword');
  const submit = document.getElementById('adminPasswordSubmit');
  const login = document.getElementById('adminAccessLogin');
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(login.value.trim())) {
    setAdminPasswordStatus('Логин: 1–64 символа, латинские буквы, цифры, точка, дефис или подчёркивание.', 'error');
    login.focus();
    return;
  }
  if (!currentPassword.value) {
    setAdminPasswordStatus('Укажите текущий пароль.', 'error');
    currentPassword.focus();
    return;
  }
  if ((newPassword.value || repeatPassword.value) && !adminPasswordIsStrong(newPassword.value)) {
    setAdminPasswordStatus('Новый пароль не соответствует требованиям.', 'error');
    showAdminPasswordRequirement(true);
    newPassword.focus();
    return;
  }
  showAdminPasswordRequirement(false);
  if (newPassword.value !== repeatPassword.value) {
    setAdminPasswordStatus('Новые пароли не совпадают.', 'error');
    repeatPassword.focus();
    return;
  }
  submit.disabled = true;
  const originalLabel = submit.textContent;
  submit.textContent = 'Сохраняем…';
  setAdminPasswordStatus('');
  try {
    const response = await fetch('/api/admin/credentials', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        login: login.value.trim(),
        currentPassword: currentPassword.value,
        newPassword: newPassword.value,
        repeatPassword: repeatPassword.value
      }),
      cache: 'no-store'
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || 'Не удалось сохранить реквизиты.');
    setAdminPasswordStatus('Реквизиты сохранены. Войдите с новым логином и действующим паролем.', 'success');
    setTimeout(() => window.location.assign('/'), 900);
  } catch (error) {
    setAdminPasswordStatus(error.message || 'Не удалось сохранить реквизиты.', 'error');
    submit.disabled = false;
    submit.textContent = originalLabel;
  }
});

const checkVersionsButton = document.getElementById('checkVersions');
checkVersionsButton.addEventListener('click', async () => {
  const awgLatest = document.getElementById('awgLatestRelease');
  const naitLatest = document.getElementById('naitLatestVersion');
  const status = document.getElementById('versionCheckStatus');
  const card = document.querySelector('.node-status-card');
  const currentProtocol = card?.dataset.protocolVersion || '';
  const currentAppVersion = card?.dataset.appVersion || '';
  const originalLabel = checkVersionsButton.textContent;
  checkVersionsButton.disabled = true;
  checkVersionsButton.textContent = 'Проверяем…';
  status.hidden = true;
  status.className = 'version-check-summary';
  status.textContent = 'Запрашиваем версии на GitHub.';
  try {
    const response = await fetch('/api/versions/latest', { cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || 'Не удалось проверить GitHub.');
    const setGithubVersion = (element, text, url, matches, title) => {
      element.className = `version-github ${matches ? 'match' : 'mismatch'}`;
      if (!text || !url) {
        element.className = 'version-github error';
        element.textContent = 'Ошибка проверки';
        return false;
      }
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = `${text} ↗`;
      if (title) link.title = title;
      element.replaceChildren(link);
      return true;
    };
    const releaseProtocol = /^v?(\d+\.\d+)/.exec(String(payload.awgTools?.tagName || ''))?.[1] || '';
    const awgChecked = setGithubVersion(
      awgLatest,
      releaseProtocol ? `AWG ${releaseProtocol}` : '',
      payload.awgTools?.releaseUrl,
      Boolean(currentProtocol && releaseProtocol === currentProtocol),
      payload.awgTools?.tagName ? `Релиз awg-tools ${payload.awgTools.tagName}` : ''
    );
    const githubAppVersion = String(payload.naitAwg?.version || '');
    const naitChecked = setGithubVersion(
      naitLatest,
      githubAppVersion ? `v${githubAppVersion}` : '',
      payload.naitAwg?.repositoryUrl,
      Boolean(currentAppVersion && githubAppVersion === currentAppVersion),
      'Nait-AWG на GitHub'
    );
    const compareVersions = (current, latest) => {
      const currentParts = String(current).split(/[.+-]/).map(Number);
      const latestParts = String(latest).split(/[.+-]/).map(Number);
      if (!current || !latest || currentParts.some(Number.isNaN) || latestParts.some(Number.isNaN)) return null;
      const length = Math.max(currentParts.length, latestParts.length);
      for (let index = 0; index < length; index += 1) {
        const difference = (currentParts[index] || 0) - (latestParts[index] || 0);
        if (difference !== 0) return Math.sign(difference);
      }
      return 0;
    };
    const awgComparison = compareVersions(currentProtocol, releaseProtocol);
    const naitComparison = compareVersions(currentAppVersion, githubAppVersion);
    status.hidden = false;
    if (!awgChecked || !naitChecked || awgComparison === null || naitComparison === null) {
      status.className = 'version-check-summary warning';
      status.textContent = 'Не всё удалось проверить';
    } else if (awgComparison === 0 && naitComparison === 0) {
      status.className = 'version-check-summary success';
      status.textContent = 'Версии совпадают';
    } else if (awgComparison < 0 && naitComparison < 0) {
      status.className = 'version-check-summary warning';
      status.textContent = 'Обновите AWG и Nait-AWG';
    } else if (awgComparison < 0) {
      status.className = 'version-check-summary warning';
      status.textContent = 'Обновите AWG';
    } else if (naitComparison < 0) {
      status.className = 'version-check-summary warning';
      status.textContent = 'Обновите Nait-AWG';
    } else {
      status.className = 'version-check-summary warning';
      status.textContent = 'На сервере установлена более новая версия';
    }
  } catch (error) {
    status.hidden = false;
    status.className = 'version-check-summary error';
    status.textContent = error.message || 'Не удалось проверить GitHub.';
    [awgLatest, naitLatest].forEach(element => {
      element.className = 'version-github error';
      element.textContent = 'Ошибка проверки';
    });
  } finally {
    checkVersionsButton.disabled = false;
    checkVersionsButton.textContent = originalLabel;
  }
});

document.querySelectorAll('.nav button[data-view]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.nav button[data-view]').forEach(item => item.classList.toggle('active', item === button));
  document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === button.dataset.view + 'View'));
}));
renderTable();

// The first render has transfer totals; subsequent read-only samples provide live rates.
const liveSamples = new Map(allRows.map(row => [row.dataset.peerId, {
  at: Date.now(), rx: Number(row.dataset.rx) || 0, tx: Number(row.dataset.tx) || 0
}]));
function trafficBytes(value) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = Math.max(0, Number(value) || 0), unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
  return amount.toFixed(amount >= 10 || unit === 0 ? 0 : 1) + ' ' + units[unit];
}
function handshakeAge(value) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return seconds + ' сек назад';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' мин назад';
  if (seconds < 86400) return Math.floor(seconds / 3600) + ' ч назад';
  return Math.floor(seconds / 86400) + ' д назад';
}
function liveTrafficBlock(arrow, rate, total, title) {
  return '<div class="gate-traffic-block" title="' + title + '"><span class="gate-traffic-arrow">' +
    arrow + '</span><div class="gate-traffic-values"><strong class="gate-traffic-rate">' +
    trafficBytes(rate) + '/s</strong><span class="gate-traffic-total">' + trafficBytes(total) +
    '</span></div></div>';
}
async function refreshLive({ render = true } = {}) {
  const response = await fetch('/api/peers', { cache: 'no-store' });
  if (!response.ok) throw new Error('Не удалось обновить список клиентов.');
  const peers = await response.json();
  const now = Date.now();
  const byId = new Map(allRows.map(row => [row.dataset.peerId, row]));
  for (const peer of peers) {
    const row = byId.get(peer.id);
    if (!row) continue;
    const rx = Math.max(0, Number(peer.transferRx) || 0);
    const tx = Math.max(0, Number(peer.transferTx) || 0);
    const previous = liveSamples.get(peer.id);
    const seconds = previous ? Math.max(1, (now - previous.at) / 1000) : 1;
    const rxRate = previous ? Math.max(0, (rx - previous.rx) / seconds) : 0;
    const txRate = previous ? Math.max(0, (tx - previous.tx) / seconds) : 0;
    liveSamples.set(peer.id, { at: now, rx, tx });
    const cell = row.cells[1];
    cell.innerHTML = rx || tx ? '<div class="gate-activity">' +
      liveTrafficBlock('↓', txRate, tx, 'Получено клиентом') +
      liveTrafficBlock('↑', rxRate, rx, 'Отправлено клиентом') + '</div>' : '';
    const active = peer.state === 'active';
    setRowStatus(row, peer.displayStatus || (active ? 'active' : 'inactive'));
    row.dataset.accessState = peer.accessState || '';
    row.dataset.lastHandshake = peer.latestHandshakeAt ? new Date(peer.latestHandshakeAt).getTime() : 0;
    row.querySelector('.gate-runtime-indicator').classList.toggle('online', active);
    const thumb = row.querySelector('.gate-client-thumb');
    const ping = thumb.querySelector('.gate-runtime-ping');
    if (active && !ping) {
      const element = document.createElement('span');
      element.className = 'gate-runtime-ping';
      thumb.insertBefore(element, thumb.querySelector('.gate-runtime-indicator'));
    } else if (!active && ping) ping.remove();
    const contact = row.querySelector('.gate-contact-line');
    let age = contact.querySelector('.gate-client-handshake');
    const ageText = handshakeAge(peer.latestHandshakeAt);
    if (ageText && !age) {
      age = document.createElement('span');
      age.className = 'gate-client-handshake';
      contact.appendChild(age);
    }
    if (age) {
      age.textContent = ageText;
      age.hidden = !ageText;
    }
    contact.hidden = !contact.querySelector('.gate-client-contact').textContent && contact.querySelector('.gate-note-icon').hidden && !ageText;
  }
  if (render && !accessBusy && (sortKey === 'activity' || sortKey === 'status' || filter !== 'all')) renderTable();
}
refreshLive().catch(console.error);
setInterval(() => {
  if (document.visibilityState === 'visible' && !accessBusy) refreshLive().catch(console.error);
}, 5000);
