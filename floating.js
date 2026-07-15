const STORAGE_KEY = "suspend-record-state-v2";
const weekdayNames = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

function readState() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { return null; } }
function dateKey(date = new Date()) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function formatDuration(seconds) { seconds = Math.max(0, Math.floor(seconds)); return `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }
function segmentSeconds(segment, record, state, now = new Date()) {
  let start = new Date(segment.start).getTime();
  let end = new Date(segment.end || now).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  if (!record.shift) return 0;
  if (record.shift) {
    const shiftStart = new Date(`${record.date}T${record.shift.start}:00`).getTime();
    const shiftEnd = new Date(`${record.date}T${record.shift.end}:00`).getTime();
    start = Math.max(start, shiftStart);
    if (segment.type === "hold" || !state.settings.allowAfterShift) end = Math.min(end, shiftEnd);
  }
  return Math.max(0, Math.floor((end - start) / 1000));
}
function stats(state, record) {
  if (!record) return { online: 0, hold: 0, target: 450 * 60 };
  const segments = [...record.segments];
  if (record.activeStatus !== "idle" && record.activeSince) segments.push({ type: record.activeStatus, start: record.activeSince, end: new Date().toISOString() });
  const online = segments.filter((segment) => segment.type === "online").reduce((sum, segment) => sum + segmentSeconds(segment, record, state), 0);
  const hold = segments.filter((segment) => segment.type === "hold").reduce((sum, segment) => sum + segmentSeconds(segment, record, state), 0);
  return { online, hold, target: (Number(record.targetMinutes) || 450) * 60 };
}
function setStatus(next) {
  const state = readState();
  const record = state?.records?.[dateKey()];
  if (!state || !record || !record.shift || record.ended) return;
  if (record.activeStatus !== "idle" && record.activeSince) record.segments.push({ type: record.activeStatus, start: record.activeSince, end: new Date().toISOString() });
  record.activeStatus = next;
  record.activeSince = new Date().toISOString();
  record.firstStarted ||= record.activeSince;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  update();
}
function update() {
  const state = readState();
  const record = state?.records?.[dateKey()];
  const item = stats(state || { settings: { allowAfterShift: true } }, record);
  const remaining = Math.max(0, item.target - item.online);
  const status = record?.activeStatus === "online" ? "在线计时中" : record?.activeStatus === "hold" ? "挂起计时中" : remaining ? "尚未开始" : "今日在线已达标";
  document.querySelector("#floating-status").textContent = `${status} · ${weekdayNames[new Date().getDay()]}`;
  document.querySelector("#floating-online").textContent = formatDuration(item.online);
  document.querySelector("#floating-remaining").textContent = remaining ? `还需 ${formatDuration(remaining)}` : "已达标";
  document.querySelector("#floating-hold").textContent = `挂起 ${formatDuration(item.hold)}`;
  const action = document.querySelector("#floating-action");
  action.textContent = record?.activeStatus === "online" ? "开始挂起" : record?.activeStatus === "hold" ? "恢复在线" : "开始在线";
  action.classList.toggle("is-hold", record?.activeStatus === "online");
}
document.querySelector("#close-floating").addEventListener("click", () => window.close());
document.querySelector("#floating-action").addEventListener("click", () => { const state = readState(); const current = state?.records?.[dateKey()]?.activeStatus; setStatus(current === "online" ? "hold" : "online"); });
update();
setInterval(update, 1000);
