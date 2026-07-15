const STORAGE_KEY = "suspend-record-state-v2";
const weekdayNames = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
const defaultShifts = [
  { id: "early", name: "早班", start: "08:30", end: "17:00" },
  { id: "middle", name: "中班", start: "11:00", end: "20:00" },
  { id: "late", name: "晚班", start: "14:00", end: "22:00" },
];

const defaultState = {
  settings: {
    targetMinutes: 450,
    theme: "system",
    shiftPrompt: true,
    allowAfterShift: true,
    floating: false,
    schedule: { 0: null, 1: "early", 2: "early", 3: "early", 4: "early", 5: "early", 6: null },
    dailyOverrides: {},
  },
  shifts: defaultShifts,
  records: {},
  lastDate: "",
  version: 2,
};

let state = loadState();
let currentView = "dashboard";
let statsRange = "week";
let toastTimer;

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || localStorage.getItem("online-achiever-state-v1"));
    if (!saved) return clone(defaultState);
    if (!saved.version || saved.version < 2) saved.settings = { ...(saved.settings || {}), allowAfterShift: true };
    return {
      ...clone(defaultState),
      ...saved,
      settings: { ...clone(defaultState).settings, ...(saved.settings || {}) },
      shifts: Array.isArray(saved.shifts) && saved.shifts.length ? saved.shifts : clone(defaultShifts),
      records: saved.records || {},
    };
  } catch { return clone(defaultState); }
}

function persist(message = "已自动保存") {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  const status = document.querySelector("#save-status");
  if (status) status.textContent = message;
}

function dateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateFromKey(key) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function shiftForDate(date = new Date()) {
  const override = state.settings.dailyOverrides[dateKey(date)];
  if (override?.shift) return override.shift;
  return state.shifts.find((shift) => shift.id === state.settings.schedule[date.getDay()]) || null;
}

function createRecord(key = dateKey()) {
  const date = dateFromKey(key);
  const shift = shiftForDate(date);
  return {
    date: key,
    shift: shift ? clone(shift) : null,
    targetMinutes: Number(state.settings.dailyOverrides[key]?.targetMinutes || state.settings.targetMinutes) || 450,
    activeStatus: "idle",
    activeSince: null,
    ended: false,
    endedAt: null,
    segments: [],
    firstStarted: null,
    achievedAt: null,
    note: "",
  };
}

function closePreviousDay(previousKey, boundary) {
  const record = state.records[previousKey];
  if (!record || !record.activeStatus || record.activeStatus === "idle" || !record.activeSince) return;
  record.segments.push({ type: record.activeStatus, start: record.activeSince, end: boundary.toISOString() });
  record.activeStatus = "idle";
  record.activeSince = null;
  record.ended = true;
  record.endedAt = boundary.toISOString();
}

function ensureToday() {
  const today = dateKey();
  let changed = false;
  if (state.lastDate && state.lastDate !== today) {
    closePreviousDay(state.lastDate, new Date(`${today}T00:00:00`));
    changed = true;
  }
  if (!state.records[today]) {
    state.records[today] = createRecord(today);
    changed = true;
  }
  if (state.lastDate !== today) {
    state.lastDate = today;
    changed = true;
  }
  if (changed) persist();
  return state.records[today];
}

function shiftBounds(record) {
  if (!record.shift) return null;
  const start = new Date(`${record.date}T${record.shift.start}:00`);
  const end = new Date(`${record.date}T${record.shift.end}:00`);
  if (end <= start) end.setDate(end.getDate() + 1);
  return { start, end };
}

function segmentSeconds(segment, record, now = new Date()) {
  let start = new Date(segment.start).getTime();
  let end = new Date(segment.end || now).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  const bounds = shiftBounds(record);
  if (!bounds) return 0;
  if (bounds) {
    start = Math.max(start, bounds.start.getTime());
    if (segment.type === "hold" || !state.settings.allowAfterShift) end = Math.min(end, bounds.end.getTime());
  }
  return Math.max(0, Math.floor((end - start) / 1000));
}

function recordStats(record, now = new Date()) {
  const segments = [...record.segments];
  if (record.activeStatus !== "idle" && record.activeSince) {
    segments.push({ type: record.activeStatus, start: record.activeSince, end: now.toISOString() });
  }
  let onlineSeconds = 0;
  let holdSeconds = 0;
  for (const segment of segments) {
    const seconds = segmentSeconds(segment, record, now);
    if (segment.type === "online") onlineSeconds += seconds;
    if (segment.type === "hold") holdSeconds += seconds;
  }
  const targetSeconds = (Number(record.targetMinutes) || 450) * 60;
  const shift = shiftBounds(record);
  const shiftSeconds = shift ? Math.max(0, (shift.end - shift.start) / 1000) : 0;
  const holdReference = Math.max(0, shiftSeconds - targetSeconds);
  return { onlineSeconds, holdSeconds, targetSeconds, holdReference, remainingSeconds: Math.max(0, targetSeconds - onlineSeconds), progress: Math.min(1, onlineSeconds / targetSeconds) };
}

function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"' && quoted) { cell += '"'; index += 1; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === "," && !quoted) { cells.push(cell.trim()); cell = ""; continue; }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function parseDailyShiftCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error("CSV 文件至少需要一行表头和一行数据");
  const headers = parseCsvLine(lines[0]).map((header) => header.replace(/\s/g, "").toLowerCase());
  const required = ["日期", "班次名称", "开始时间", "结束时间", "目标在线分钟"];
  const positions = required.map((header) => headers.indexOf(header.toLowerCase()));
  if (positions.some((position) => position < 0)) throw new Error("表头必须包含：日期、班次名称、开始时间、结束时间、目标在线分钟");
  return lines.slice(1).map((line, rowIndex) => {
    const cells = parseCsvLine(line);
    const [date, name, start, end, target] = positions.map((position) => cells[position] || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || dateKey(dateFromKey(date)) !== date) throw new Error(`第 ${rowIndex + 2} 行日期无效`);
    if (!name || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || end <= start) throw new Error(`第 ${rowIndex + 2} 行班次时间无效`);
    const targetMinutes = Number(target || state.settings.targetMinutes);
    if (!Number.isFinite(targetMinutes) || targetMinutes <= 0 || targetMinutes > 1440) throw new Error(`第 ${rowIndex + 2} 行目标在线分钟无效`);
    return { date, name, start, end, targetMinutes };
  });
}

async function importDailyShiftFile(file) {
  const rows = parseDailyShiftCsv(await file.text());
  let imported = 0;
  let updated = 0;
  for (const row of rows) {
    const override = { shift: { id: `daily-${row.date}`, name: row.name, start: row.start, end: row.end }, targetMinutes: row.targetMinutes };
    state.settings.dailyOverrides[row.date] = override;
    imported += 1;
    const existing = state.records[row.date];
    if (existing && !existing.firstStarted && !existing.segments.length && !existing.ended) {
      existing.shift = clone(override.shift);
      existing.targetMinutes = row.targetMinutes;
      updated += 1;
    }
  }
  persist();
  renderAll();
  const status = document.querySelector("#import-status");
  status.textContent = `已导入 ${imported} 天班次${updated ? `，更新 ${updated} 条未开始记录` : ""}。`;
  showToast(`已导入 ${imported} 天班次`);
}

function downloadShiftTemplate() {
  const csv = "日期,班次名称,开始时间,结束时间,目标在线分钟\n";
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "每日班次导入模板.csv";
  link.click();
  URL.revokeObjectURL(link.href);
  showToast("导入模板已下载");
}

function openFloatingWindow() {
  const tauriInvoke = window.__TAURI_INTERNALS__?.invoke;
  if (tauriInvoke) {
    tauriInvoke("show_floating").then(() => {
      state.settings.floating = true;
      persist();
      showToast("悬浮窗已打开");
    }).catch(() => showToast("悬浮窗暂时无法打开"));
    return;
  }
  const popup = window.open("floating.html", "hangup-record-floating", "popup=yes,width=320,height=250,resizable=yes");
  if (!popup) { showToast("悬浮窗被浏览器拦截，请允许弹出窗口"); return; }
  state.settings.floating = true;
  persist();
  showToast("悬浮窗已打开");
}

function formatDuration(seconds) {
  seconds = Math.max(0, Math.floor(seconds));
  const hours = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const secs = String(seconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${secs}`;
}

function formatTime(date) { return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }); }
function formatDate(key) { return key.replaceAll("-", "/"); }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }

function currentRecord() { return ensureToday(); }

function applyTheme() {
  const setting = state.settings.theme;
  const dark = setting === "dark" || (setting === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2200);
}

function statusCopy(record, stats) {
  if (!record.shift) return { title: "今天是休息日", badge: "休息日", className: "status-idle" };
  if (record.ended) return stats.remainingSeconds ? { title: "今日记录已结束", badge: "未达标", className: "status-hold" } : { title: "今日在线已达标", badge: "已达标", className: "status-done" };
  if (record.activeStatus === "online") return { title: "在线计时中", badge: "在线", className: "status-online" };
  if (record.activeStatus === "hold") return { title: "挂起计时中", badge: "挂起", className: "status-hold" };
  if (!stats.remainingSeconds) return { title: "今日在线已达标", badge: "已达标", className: "status-done" };
  return { title: record.firstStarted ? "等待继续在线" : "尚未开始记录", badge: record.firstStarted ? "未计时" : "未开始", className: "status-idle" };
}

function updateTodayShiftSelector(record) {
  const select = document.querySelector("#today-shift-select");
  const current = record.shift;
  const shifts = [...state.shifts];
  if (current && !shifts.some((shift) => shift.id === current.id)) shifts.unshift(current);
  select.innerHTML = `<option value="">今日休息</option>${shifts.map((shift) => `<option value="${escapeHtml(shift.id)}">${escapeHtml(shift.name)} ${shift.start}-${shift.end}</option>`).join("")}`;
  select.value = current?.id || "";
}

function updateHeader(record) {
  const today = new Date();
  document.querySelector("#today-weekday").textContent = `${weekdayNames[today.getDay()]} · ${formatDate(record.date)}`;
  updateTodayShiftSelector(record);
}

function changeTodayShift(shiftId) {
  const record = currentRecord();
  if (!shiftId) {
    record.shift = null;
    delete state.settings.dailyOverrides[record.date];
  } else {
    const shift = state.shifts.find((item) => item.id === shiftId) || (record.shift?.id === shiftId ? record.shift : null);
    if (!shift) return;
    record.shift = clone(shift);
    state.settings.dailyOverrides[record.date] = { shift: clone(shift), targetMinutes: record.targetMinutes };
  }
  persist();
  renderAll();
  showToast(record.shift ? `今日班次已切换为${record.shift.name}` : "今日已设为休息日");
}

function renderDashboard() {
  const record = currentRecord();
  const stats = recordStats(record);
  const copy = statusCopy(record, stats);
  updateHeader(record);
  document.querySelector("#status-title").textContent = copy.title;
  const badge = document.querySelector("#status-badge");
  badge.textContent = copy.badge;
  badge.className = `status-badge ${copy.className}`;
  document.querySelector("#progress-percent").textContent = `${Math.round(stats.progress * 100)}%`;
  document.querySelector("#progress-ring").style.setProperty("--progress", `${stats.progress * 360}deg`);
  document.querySelector("#online-duration").textContent = formatDuration(stats.onlineSeconds);
  document.querySelector("#target-duration").textContent = formatDuration(stats.targetSeconds);
  document.querySelector("#remaining-duration").textContent = stats.remainingSeconds ? formatDuration(stats.remainingSeconds) : "已达标";
  document.querySelector("#remaining-label").textContent = stats.remainingSeconds ? "还需在线" : "今日目标已完成";
  document.querySelector("#hold-duration").textContent = formatDuration(stats.holdSeconds);
  const holdRemaining = stats.holdReference - stats.holdSeconds;
  const holdRow = document.querySelector("#hold-remaining-row");
  holdRow.classList.toggle("is-warning", holdRemaining < 0);
  document.querySelector("#hold-remaining").textContent = holdRemaining >= 0 ? formatDuration(holdRemaining) : `超出 ${formatDuration(Math.abs(holdRemaining))}`;
  document.querySelector("#hold-remaining-label").textContent = holdRemaining >= 0 ? "可安排休息" : "请留意补时";
  const primary = document.querySelector("#primary-action");
  primary.disabled = !record.shift || record.ended;
  primary.textContent = record.activeStatus === "online" ? "开始挂起" : record.activeStatus === "hold" ? "恢复在线" : "开始在线";
  document.querySelector("#progress-note").textContent = !record.shift ? "今日没有配置班次" : stats.remainingSeconds ? (record.activeStatus === "hold" ? "当前挂起中，在线进度暂不增加" : "有效在线时长会按秒累计") : "今日目标已完成，可继续记录超额在线";
  const expected = document.querySelector("#expected-end");
  const expectedLabel = document.querySelector("#expected-label");
  if (!record.shift || !record.firstStarted) { expected.textContent = "开始在线后计算"; expectedLabel.textContent = "根据当前状态估算"; }
  else if (!stats.remainingSeconds) { expected.textContent = record.achievedAt ? formatTime(new Date(record.achievedAt)) : "已达标"; expectedLabel.textContent = "实际达标时间"; }
  else { const expectedDate = new Date(Date.now() + stats.remainingSeconds * 1000); expected.textContent = formatTime(expectedDate); expectedLabel.textContent = record.activeStatus === "hold" ? "恢复在线后预计完成" : "预计完成时间"; }
  document.querySelector("#last-action").textContent = record.segments.length ? `最近记录 ${formatTime(new Date(record.segments[record.segments.length - 1].end))}` : "暂无状态变化";
  document.querySelector("#notice-title").textContent = !record.shift ? "今天是休息日" : stats.remainingSeconds ? "按需安排休息" : "今日在线已达标";
  document.querySelector("#notice-text").textContent = !record.shift ? "可以在设置中为今天绑定班次。" : stats.remainingSeconds ? "挂起参考只用于提醒，不会自动停止计时。" : "可以结束今日记录，或继续记录超额在线。";
  renderTimeline(record);
}

function renderTimeline(record) {
  const timeline = document.querySelector("#timeline");
  const segments = [...record.segments];
  if (record.activeStatus !== "idle" && record.activeSince) segments.push({ type: record.activeStatus, start: record.activeSince, end: new Date().toISOString() });
  if (!segments.length) { timeline.innerHTML = `<div class="timeline-empty">开始在线后，今天的状态区间会显示在这里</div>`; return; }
  timeline.innerHTML = segments.map((segment) => `<div class="timeline-item"><div class="timeline-time">${formatTime(new Date(segment.start))}</div><div class="timeline-rail"><span class="timeline-dot ${segment.type}"></span></div><div class="timeline-content"><strong>${segment.type === "online" ? "在线" : "挂起"}</strong><span>${formatDuration(segmentSeconds(segment, record))}</span></div></div>`).join("");
}

function closeActive(record, end = new Date()) {
  if (record.activeStatus !== "idle" && record.activeSince) {
    record.segments.push({ type: record.activeStatus, start: record.activeSince, end: end.toISOString() });
  }
  record.activeStatus = "idle";
  record.activeSince = null;
}

function setStatus(nextStatus) {
  const record = currentRecord();
  if (!record.shift || record.ended) return;
  const now = new Date();
  closeActive(record, now);
  if (nextStatus !== "idle") {
    record.activeStatus = nextStatus;
    record.activeSince = now.toISOString();
    record.firstStarted ||= now.toISOString();
  }
  const stats = recordStats(record, now);
  if (!record.achievedAt && !stats.remainingSeconds) record.achievedAt = now.toISOString();
  persist();
  renderAll();
}

function finishToday() {
  const record = currentRecord();
  if (record.ended) return;
  if (!record.firstStarted && !record.segments.length) { showToast("今天还没有计时记录"); return; }
  if (!confirm("结束今日记录后，今天不会继续自动累计。确定结束吗？")) return;
  closeActive(record);
  record.ended = true;
  record.endedAt = new Date().toISOString();
  persist("今日记录已保存");
  showToast("今日记录已结束");
  renderAll();
}

function renderStats() {
  const today = new Date();
  let keys = Object.keys(state.records).sort().reverse();
  if (statsRange === "week") {
    const start = new Date(today); start.setDate(today.getDate() - ((today.getDay() + 6) % 7)); start.setHours(0, 0, 0, 0);
    keys = keys.filter((key) => dateFromKey(key) >= start);
  } else if (statsRange === "month") keys = keys.filter((key) => dateFromKey(key).getMonth() === today.getMonth() && dateFromKey(key).getFullYear() === today.getFullYear());
  const records = keys.map((key) => state.records[key]);
  const summaries = records.map((record) => recordStats(record));
  const totalOnline = summaries.reduce((sum, item) => sum + item.onlineSeconds, 0);
  const totalHold = summaries.reduce((sum, item) => sum + item.holdSeconds, 0);
  const target = summaries.reduce((sum, item) => sum + item.targetSeconds, 0);
  const achieved = summaries.filter((item) => item.remainingSeconds === 0).length;
  document.querySelector("#stats-summary").innerHTML = [
    ["实际在线", formatDuration(totalOnline)], ["目标在线", formatDuration(target)], ["达标天数", `${achieved} 天`], ["累计挂起", formatDuration(totalHold)],
  ].map(([label, value]) => `<div class="summary-item"><span>${label}</span><strong>${value}</strong><small>${statsRange === "week" ? "本周" : statsRange === "month" ? "本月" : "全部已记录"}</small></div>`).join("");
  document.querySelector("#stats-table-body").innerHTML = records.length ? records.map((record) => {
    const item = recordStats(record);
    const date = dateFromKey(record.date);
    const result = !record.shift ? ["休息日", "result-empty"] : item.remainingSeconds ? [`还需 ${formatDuration(item.remainingSeconds)}`, "result-warn"] : ["已达标", "result-good"];
    return `<tr><td>${formatDate(record.date)}</td><td>${weekdayNames[date.getDay()]}</td><td>${record.shift ? `${escapeHtml(record.shift.name)} ${record.shift.start}-${record.shift.end}` : "休息日"}</td><td>${formatDuration(item.targetSeconds)}</td><td>${formatDuration(item.onlineSeconds)}</td><td>${formatDuration(item.holdSeconds)}</td><td class="${result[1]}">${result[0]}</td></tr>`;
  }).join("") : `<tr><td colspan="7" class="result-empty">当前范围暂无记录</td></tr>`;
}

function renderSettings() {
  document.querySelector("#target-minutes").value = state.settings.targetMinutes;
  document.querySelector("#theme-select").value = state.settings.theme;
  document.querySelector("#shift-prompt-toggle").checked = state.settings.shiftPrompt;
  document.querySelector("#after-shift-toggle").checked = state.settings.allowAfterShift;
  document.querySelector("#floating-toggle").checked = state.settings.floating;
  const overrideCount = Object.keys(state.settings.dailyOverrides || {}).length;
  document.querySelector("#import-status").textContent = overrideCount ? `已配置 ${overrideCount} 天每日班次；导入会覆盖同日期的预设。` : "支持日期、班次名称、开始时间、结束时间和目标在线分钟。";
  const options = `<option value="">休息日</option>${state.shifts.map((shift) => `<option value="${shift.id}">${escapeHtml(shift.name)} ${shift.start}-${shift.end}</option>`).join("")}`;
  document.querySelector("#schedule-list").innerHTML = [1, 2, 3, 4, 5, 6, 0].map((day) => `<label class="schedule-row"><span>${weekdayNames[day]}</span><select data-day="${day}">${options}</select></label>`).join("");
  document.querySelectorAll("#schedule-list select").forEach((select) => { select.value = state.settings.schedule[select.dataset.day] || ""; });
  document.querySelector("#custom-shift-list").innerHTML = state.shifts.filter((shift) => !defaultShifts.some((base) => base.id === shift.id)).map((shift) => `<div class="custom-shift-row"><span>${escapeHtml(shift.name)} ${shift.start}-${shift.end}</span><button class="remove-shift" data-remove-shift="${shift.id}">删除</button></div>`).join("") || `<span class="muted">暂无自定义班次</span>`;
}

function renderAll() {
  applyTheme();
  renderDashboard();
  renderStats();
  renderSettings();
}

function switchView(view) {
  currentView = view;
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("is-active", button.dataset.view === view));
  document.querySelectorAll(".view").forEach((section) => section.classList.toggle("is-visible", section.id === `view-${view}`));
  document.querySelector("#view-title").textContent = view === "dashboard" ? "今日工作" : view === "stats" ? "统计记录" : "设置";
  renderAll();
}

function exportExcel() {
  const records = Object.values(state.records).sort((a, b) => a.date.localeCompare(b.date));
  if (!records.length) { showToast("暂无记录可导出"); return; }
  const rows = records.map((record) => {
    const stats = recordStats(record);
    const date = dateFromKey(record.date);
    return [record.date, weekdayNames[date.getDay()], record.shift?.name || "休息日", record.shift ? `${record.shift.start}-${record.shift.end}` : "", formatDuration(stats.targetSeconds), formatDuration(stats.onlineSeconds), formatDuration(stats.holdSeconds), stats.remainingSeconds ? `还需 ${formatDuration(stats.remainingSeconds)}` : "已达标"];
  });
  const table = `<meta charset="utf-8"><table border="1"><tr><th>日期</th><th>星期</th><th>班次</th><th>班次时间</th><th>目标在线</th><th>实际在线</th><th>挂起时长</th><th>结果</th></tr>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</table>`;
  const blob = new Blob(["\ufeff", table], { type: "application/vnd.ms-excel;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `挂起记录统计_${dateKey().replaceAll("-", "")}.xls`;
  link.click();
  URL.revokeObjectURL(link.href);
  showToast("Excel 文件已导出");
}

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((element) => element.addEventListener("click", () => switchView(element.dataset.view)));
  document.querySelector("#primary-action").addEventListener("click", () => setStatus(currentRecord().activeStatus === "online" ? "hold" : "online"));
  document.querySelector("#finish-action").addEventListener("click", finishToday);
  document.querySelector("#export-action").addEventListener("click", exportExcel);
  document.querySelectorAll(".segment").forEach((button) => button.addEventListener("click", () => { statsRange = button.dataset.range; document.querySelectorAll(".segment").forEach((item) => item.classList.toggle("is-active", item === button)); renderStats(); }));
  document.querySelector("#today-shift-select").addEventListener("change", (event) => changeTodayShift(event.target.value));
  document.querySelector("#target-minutes").addEventListener("change", (event) => { state.settings.targetMinutes = Math.max(1, Number(event.target.value) || 450); persist(); renderAll(); });
  document.querySelector("#theme-select").addEventListener("change", (event) => { state.settings.theme = event.target.value; persist(); renderAll(); });
  document.querySelector("#shift-prompt-toggle").addEventListener("change", (event) => { state.settings.shiftPrompt = event.target.checked; persist(); });
  document.querySelector("#after-shift-toggle").addEventListener("change", (event) => { state.settings.allowAfterShift = event.target.checked; persist(); renderAll(); });
  document.querySelector("#floating-toggle").addEventListener("change", (event) => { state.settings.floating = event.target.checked; persist(); showToast(event.target.checked ? "悬浮窗入口已启用" : "悬浮窗入口已关闭"); });
  document.querySelector("#download-shift-template").addEventListener("click", downloadShiftTemplate);
  document.querySelector("#shift-import-input").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try { await importDailyShiftFile(file); } catch (error) { showToast(error.message || "班次导入失败"); }
    event.target.value = "";
  });
  document.querySelector("#schedule-list").addEventListener("change", (event) => { if (event.target.matches("select")) { state.settings.schedule[event.target.dataset.day] = event.target.value || null; persist(); renderAll(); showToast("班次安排已保存"); } });
  document.querySelector("#add-shift-action").addEventListener("click", () => {
    const name = document.querySelector("#new-shift-name").value.trim();
    const start = document.querySelector("#new-shift-start").value;
    const end = document.querySelector("#new-shift-end").value;
    if (!name || !start || !end || end <= start) { showToast("请填写名称，并确保结束时间晚于开始时间"); return; }
    const id = `custom-${Date.now()}`;
    state.shifts.push({ id, name, start, end });
    persist();
    document.querySelector("#new-shift-name").value = "";
    renderAll();
    showToast("自定义班次已添加");
  });
  document.querySelector("#custom-shift-list").addEventListener("click", (event) => {
    const id = event.target.dataset.removeShift;
    if (!id) return;
    state.shifts = state.shifts.filter((shift) => shift.id !== id);
    Object.keys(state.settings.schedule).forEach((day) => { if (state.settings.schedule[day] === id) state.settings.schedule[day] = null; });
    persist(); renderAll(); showToast("自定义班次已删除");
  });
  document.querySelector("#reset-data-action").addEventListener("click", () => { if (!confirm("确认清空所有本地记录和设置吗？")) return; state = clone(defaultState); persist("数据已重置"); renderAll(); showToast("本地数据已清空"); });
  document.querySelector("#open-floating").addEventListener("click", openFloatingWindow);
}

ensureToday();
bindEvents();
renderAll();
setInterval(() => { ensureToday(); renderDashboard(); if (currentView === "stats") renderStats(); }, 1000);
