/* dashboard.js — v0.4.0 — Bảng điều khiển quản lý & theo dõi giá CPU */
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const A = CPUAnalyzer;

const COND = { 'new-sealed': 'Mới seal', 'new-tray': 'Mới tray', 'used': 'Đã dùng', 'unknown': 'Chưa rõ' };
const TYPE = { sell: 'Bán', buy: 'Cần mua', combo: 'Combo', inbox: 'Giá inbox', unknown: 'Chưa rõ' };
const DEFAULTS = {
  enabled: true,
  autoOpenWatcher: true,
  reloadMinutes: 3,
  minGapSec: 8,
  maxPerHour: 60,
  keywordFilter: false,
  maxConsecutiveErrors: 5,
  dedupHours: 48,
  filterOutliers: true,
  autoPruneDays: 90,
  alerts: []
};

let S = {
  settings: DEFAULTS,
  posts: {},
  queue: [],
  active: null,
  stats: {},
  log: [],
  pauseReason: null,
  consecutiveErrors: 0,
  alertHistory: []
};
let selected = null;
let renderTimer = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = (t) => {
  if (!t) return 'chưa có';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'vừa xong';
  if (m < 60) return m + ' phút trước';
  if (m < 1440) return Math.round(m / 60) + ' giờ trước';
  return Math.round(m / 1440) + ' ngày trước';
};

async function load() {
  const d = await chrome.storage.local.get([
    'settings', 'posts', 'queue', 'active', 'stats', 'log',
    'pauseReason', 'consecutiveErrors', 'alertHistory'
  ]);
  S = {
    settings: { ...DEFAULTS, ...(d.settings || {}) },
    posts: d.posts || {},
    queue: d.queue || [],
    active: d.active || null,
    stats: d.stats || {},
    log: d.log || [],
    pauseReason: d.pauseReason || null,
    consecutiveErrors: d.consecutiveErrors || 0,
    alertHistory: d.alertHistory || []
  };
  render();
}
chrome.storage.onChanged.addListener(() => { clearTimeout(renderTimer); renderTimer = setTimeout(load, 300); });

/* Chuyển đổi dữ liệu posts thành danh sách phẳng các dòng tin */
function rows() {
  const out = [];
  for (const [key, p] of Object.entries(S.posts)) {
    (p.listings || []).forEach((l, idx) => {
      if (l.ignored) return;
      out.push({
        ...l,
        category: l.category || 'CPU',
        key,
        idx,
        url: p.url,
        at: p.collectedAt,
        group: p.groupName,
        author: p.author,
        imageCount: p.imageCount,
        text: p.text
      });
    });
  }
  return out;
}

/* Áp dụng bộ lọc người dùng chọn trên giao diện */
function filtered(all) {
  const cat = $('#f-cat')?.value || '';
  const days = +$('#f-range').value;
  const cond = $('#f-cond').value;
  const soldMode = $('#f-sold').value;
  const dedupChecked = $('#f-dedup').checked;
  const outlierChecked = $('#f-outlier').checked;
  const q = $('#f-q').value.trim().toLowerCase().replace(/[\s\-]/g, '');

  return all.filter(r => {
    // 0. Lọc theo danh mục linh kiện (CPU, VGA, Main, RAM, SSD)
    if (cat && r.category !== cat) return false;
    // 1. Khoảng thời gian
    if (days && Date.now() - r.at > days * 864e5) return false;
    // 2. Tình trạng
    if (cond && r.condition !== cond) return false;
    // 3. Trạng thái Đang rao vs Đã bán
    if (soldMode === 'active' && r.isSold) return false;
    if (soldMode === 'sold' && !r.isSold) return false;
    // 4. Lọc bài đăng lặp (dedup)
    if (dedupChecked && r.isDuplicate) return false;
    // 4b. Lọc bài đăng chéo (crosspost)
    const crosspostChecked = $('#f-crosspost')?.checked;
    if (crosspostChecked && (r.isCrossPost || r.isDuplicate)) return false;
    // 5. Lọc giá bất thường (outlier)
    if (outlierChecked && r.isOutlier) return false;
    // 6. Tìm kiếm mẫu linh kiện
    if (q && !r.model.toLowerCase().replace(/[\s\-]/g, '').includes(q)) return false;
    return true;
  });
}

const isValid = (r) => r.priceType === 'sell' && r.price != null && !r.needsReview;

function render() {
  const st = S.stats;
  const waiting = S.queue.length + (S.active ? 1 : 0);
  $('#status-line').textContent =
    `Đã thu ${st.collected || 0} bài có linh kiện · bỏ qua ${st.skipped || 0} bài không có linh kiện · lỗi ${st.failed || 0} · đang chờ ${waiting} · thu gần nhất ${ago(st.lastCollectedAt)}`;

  // Nút bật/tắt thu thập
  const tg = $('#btn-toggle');
  tg.textContent = S.settings.enabled ? 'Tạm dừng' : 'Tiếp tục thu thập';
  tg.className = S.settings.enabled ? '' : 'primary';

  // Banner cảnh báo tự động tạm dừng
  const pauseBanner = $('#pause-banner');
  if (S.pauseReason) {
    pauseBanner.hidden = false;
    pauseBanner.style.display = 'flex';
    $('#pause-title').textContent = '⚠️ Đã tự động tạm dừng an toàn';
    $('#pause-desc').textContent = `${S.pauseReason}. Extension đã ngừng mở tab để tránh rủi ro cho tài khoản của bạn.`;
  } else {
    pauseBanner.hidden = true;
    pauseBanner.style.display = 'none';
  }

  const all = rows();
  const list = filtered(all);

  renderTable(list, all);
  renderDetail(list);
  renderReview(all);
  renderAlerts();
  renderBackupInfo();
  renderSettings();
  renderLog();
  checkWatcher();
}

/* Tính trung vị của một mẫu CPU trong khoảng thời gian cụ thể */
function getMedianForRange(allRows, model, startMs, endMs) {
  const match = allRows.filter(r =>
    isValid(r) &&
    !r.isSold &&
    !r.isDuplicate &&
    !r.isOutlier &&
    r.model === model &&
    r.at >= startMs &&
    r.at <= endMs
  );
  if (!match.length) return null;
  const sm = A.summarize(match.map(r => r.price));
  return sm ? sm.median : null;
}

/* Render bảng tổng hợp giá và xu hướng tuần */
function renderTable(list, allRows) {
  const byModel = new Map();
  list.filter(isValid).forEach(r => {
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model).push(r);
  });

  const now = Date.now();
  const week1Start = now - 7 * 864e5;
  const week2Start = now - 14 * 864e5;

  const data = [...byModel.entries()].map(([model, rs]) => {
    const sm = A.summarize(rs.map(r => r.price));
    const latest = rs.slice().sort((a, b) => b.at - a.at)[0];

    // Xu hướng tuần: trung vị 7 ngày gần nhất vs trung vị 7 ngày trước đó
    const medCur = getMedianForRange(allRows, model, week1Start, now) || sm.median;
    const medPrev = getMedianForRange(allRows, model, week2Start, week1Start);
    const trend = A.calculateTrend(medCur, medPrev);

    const cat = rs[0]?.category || 'CPU';
    return {
      model,
      category: cat,
      ...sm,
      latest: latest.price,
      latestAt: latest.at,
      trend
    };
  }).sort((a, b) => b.n - a.n || a.model.localeCompare(b.model));

  const tb = $('#tbl tbody');
  tb.innerHTML = data.map(d => {
    let trendClass = 'trend-flat';
    if (d.trend.direction === 'down') trendClass = 'trend-down';
    else if (d.trend.direction === 'up') trendClass = 'trend-up';

    return `
      <tr tabindex="0" data-model="${esc(d.model)}" class="${d.model === selected ? 'sel' : ''}">
        <td>
          <span class="cat-tag ${esc(d.category)}">${esc(d.category)}</span>
          <strong>${esc(d.model)}</strong>
        </td>
        <td class="n">${d.n}</td>
        <td class="n"><span class="trend-pill ${trendClass}" title="So sánh trung vị tuần này vs tuần trước">${esc(d.trend.text)}</span></td>
        <td class="n" title="${A.fmtFull(d.min)}">${A.fmtShort(d.min)}</td>
        <td class="n" title="${A.fmtFull(d.median)}"><strong>${A.fmtShort(d.median)}</strong></td>
        <td class="n" title="${A.fmtFull(Math.round(d.mean))}">${A.fmtShort(d.mean)}</td>
        <td class="n" title="${A.fmtFull(d.mode)}">${A.fmtShort(d.mode)}</td>
        <td class="n" title="${A.fmtFull(d.latest)} — ${ago(d.latestAt)}">${A.fmtShort(d.latest)}</td>
      </tr>`;
  }).join('');

  tb.querySelectorAll('tr').forEach(tr => {
    const pick = () => { selected = tr.dataset.model; render(); };
    tr.addEventListener('click', pick);
    tr.addEventListener('keydown', e => { if (e.key === 'Enter') pick(); });
  });

  const empty = $('#empty');
  empty.hidden = data.length > 0;
  if (!data.length) {
    empty.textContent = Object.keys(S.posts).length
      ? 'Không có bài nào khớp với bộ lọc hiện tại. Thử chọn "Tất cả" hoặc tắt bớt tuỳ chọn lọc.'
      : 'Chưa có dữ liệu. Giữ tab thông báo Facebook mở, bài viết mua bán CPU sẽ tự được thu thập.';
  }
  if (selected && !byModel.has(selected)) selected = null;
}

/* Render chi tiết bài đăng và biểu đồ của mẫu CPU được chọn */
function renderDetail(list) {
  const title = $('#detail-title'), chart = $('#chart'), ul = $('#detail-list');
  if (!selected) {
    title.textContent = 'Chọn một mẫu CPU';
    chart.innerHTML = '<p class="hint">Bấm vào một dòng trong bảng bên trái để xem lịch sử giá và các bài đăng cụ thể.</p>';
    ul.innerHTML = '';
    return;
  }
  const rs = list.filter(r => isValid(r) && r.model === selected).sort((a, b) => a.at - b.at);
  title.textContent = selected;
  chart.innerHTML = chartSVG(rs);

  ul.innerHTML = rs.slice().reverse().slice(0, 50).map(r => `
    <li>
      <span class="p" title="${A.fmtFull(r.price)}">${A.fmtShort(r.price)}</span>
      <span class="tag ${r.condition}">${COND[r.condition]}</span>
      ${r.isSold ? '<span class="tag sold">ĐÃ BÁN</span>' : ''}
      ${r.isDuplicate ? '<span class="tag dup" title="Bài đăng lặp lại trong 48h">LẶP</span>' : ''}
      ${r.isOutlier ? '<span class="tag outlier" title="Giá bất thường">ẢO</span>' : ''}
      <span class="g" title="${esc(r.group)}">${esc(r.group || 'Nhóm không rõ')} · ${esc(r.author || 'ẩn danh')} · ${ago(r.at)}</span>
      <a href="${esc(r.url)}" target="_blank" rel="noopener">Mở bài</a>
    </li>`).join('');
}

function chartSVG(rs) {
  if (!rs.length) return '<p class="hint">Chưa có bài bán hợp lệ để vẽ biểu đồ.</p>';
  const W = 640, H = 220, P = { l: 56, r: 12, t: 14, b: 28 };
  const vals = rs.map(r => r.price);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (lo === hi) { lo *= 0.95; hi *= 1.05; }
  const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
  const t0 = rs[0].at, t1 = rs[rs.length - 1].at;
  const x = (t) => P.l + (t1 === t0 ? (W - P.l - P.r) / 2 : (t - t0) / (t1 - t0) * (W - P.l - P.r));
  const y = (v) => P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b);

  const days = new Map();
  rs.forEach(r => {
    const k = new Date(r.at).toDateString();
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(r);
  });
  const med = [...days.values()].map(g => ({
    t: g.reduce((a, r) => a + r.at, 0) / g.length,
    v: A.summarize(g.map(r => r.price)).median
  }));

  const line = med.length > 1
    ? `<polyline fill="none" stroke="#0f766e" stroke-width="2.5" stroke-linejoin="round" points="${med.map(p => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')}"/>`
    : '';

  const dots = rs.map(r => {
    const color = r.isSold ? '#6b7280' : '#0f766e';
    return `<circle cx="${x(r.at).toFixed(1)}" cy="${y(r.price).toFixed(1)}" r="${r.isSold ? '3' : '4'}" fill="${color}" fill-opacity="${r.isSold ? '.4' : '.65'}">
      <title>${r.isSold ? '[ĐÃ BÁN] ' : ''}${A.fmtFull(r.price)} · ${esc(r.author || '')} · ${new Date(r.at).toLocaleString('vi-VN')}</title>
    </circle>`;
  }).join('');

  let grid = '';
  for (let i = 0; i <= 3; i++) {
    const v = lo + (hi - lo) * i / 3;
    grid += `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" stroke="#e6ebf0"/><text x="${P.l - 6}" y="${y(v) + 4}" text-anchor="end">${A.fmtShort(v)}</text>`;
  }
  const d = (t) => new Date(t).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
  const xl = `<text x="${P.l}" y="${H - 6}">${d(t0)}</text><text x="${W - P.r}" y="${H - 6}" text-anchor="end">${d(t1)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Lịch sử giá ${esc(selected)}">${grid}${line}${dots}${xl}</svg>`;
}

/* Render mục cần kiểm tra & phát hiện giá ảo / gõ nhầm */
function renderReview(all) {
  const need = all.filter(r => r.needsReview || r.isOutlier).sort((a, b) => b.at - a.at).slice(0, 80);
  const totalCount = all.filter(r => r.needsReview || r.isOutlier).length;
  $('#review-count').textContent = `(${totalCount})`;
  $('#review-badge').textContent = totalCount;

  const ul = $('#review');
  if (!need.length) {
    ul.innerHTML = '<li class="hint">Tuyệt vời! Không có bài nào cần kiểm tra hoặc nghi vấn giá gõ nhầm.</li>';
    return;
  }
  ul.innerHTML = need.map(r => `
    <li class="rv" data-key="${esc(r.key)}" data-idx="${r.idx}">
      <div class="meta">
        <strong>${esc(r.model)}</strong>
        <span class="tag ${r.condition}">${COND[r.condition]}</span>
        ${r.isSold ? '<span class="tag sold">ĐÃ BÁN</span>' : ''}
        ${r.isOutlier ? '<span class="tag outlier">GIÁ BẤT THƯỜNG</span>' : ''}
        <span class="why">${esc(r.outlierReason || r.reviewReason || 'Cần xác nhận giá')}</span>
        <span class="g">${esc(r.group || '')} · ${esc(r.author || 'ẩn danh')} · ${ago(r.at)}</span>
        <a href="${esc(r.url)}" target="_blank" rel="noopener">Mở bài</a>
        ${r.imageCount ? `<span class="imgs">${r.imageCount} ảnh — giá có thể nằm trong ảnh</span>` : ''}
      </div>
      <blockquote>${esc(r.line)}</blockquote>
      <div class="ctl">
        <input type="text" class="price-in" placeholder="Giá, vd 2tr2" value="${r.price ? A.fmtShort(r.price) : ''}" aria-label="Giá">
        <select class="type-in" aria-label="Loại tin">
          <option value="sell" ${r.priceType === 'sell' ? 'selected' : ''}>Bán</option>
          <option value="buy" ${r.priceType === 'buy' ? 'selected' : ''}>Cần mua</option>
          <option value="combo" ${r.priceType === 'combo' ? 'selected' : ''}>Combo</option>
        </select>
        <label class="chk" style="font-size:12px;">
          <input type="checkbox" class="sold-in" ${r.isSold ? 'checked' : ''}> Đã bán
        </label>
        <button class="primary ok">Duyệt</button>
        <button class="skip">Bỏ qua</button>
      </div>
    </li>`).join('');

  ul.querySelectorAll('.rv').forEach(li => {
    const key = li.dataset.key, idx = +li.dataset.idx;
    li.querySelector('.ok').addEventListener('click', async () => {
      const type = li.querySelector('.type-in').value;
      const isSold = li.querySelector('.sold-in').checked;
      const price = A.parsePrice(li.querySelector('.price-in').value);
      if (type === 'sell' && price == null) {
        li.querySelector('.price-in').focus();
        li.querySelector('.price-in').style.borderColor = '#b42318';
        return;
      }
      await patch(key, idx, {
        price: price ?? null,
        priceType: type,
        isSold,
        needsReview: false,
        isOutlier: false,
        reviewed: true
      });
    });
    li.querySelector('.skip').addEventListener('click', () => {
      patch(key, idx, { ignored: true, needsReview: false, isOutlier: false });
    });
  });
}

async function patch(key, idx, fields) {
  const { posts = {} } = await chrome.storage.local.get('posts');
  if (!posts[key] || !posts[key].listings[idx]) return;
  Object.assign(posts[key].listings[idx], fields);
  await chrome.storage.local.set({ posts });
}

/* Render Tab Theo dõi kèo mong muốn (Wishlist) */
function renderAlerts() {
  const alerts = S.settings.alerts || [];
  $('#alert-badge').textContent = alerts.length;
  $('#alert-badge').hidden = alerts.length === 0;

  const ul = $('#alert-list');
  if (!alerts.length) {
    ul.innerHTML = '<li class="hint">Chưa có mục theo dõi nào. Điền form bên trái để thêm mẫu CPU và mức giá bạn muốn săn!</li>';
  } else {
    ul.innerHTML = alerts.map(al => `
      <li class="alert-item" data-id="${al.id}">
        <div class="alert-item-info">
          <strong>${esc(al.model)}</strong>
          <span class="p-target">≤ ${A.fmtShort(al.maxPrice)}</span>
          ${al.condition ? `<span class="tag ${al.condition}">${COND[al.condition]}</span>` : ''}
          ${al.note ? `<span class="sub" style="display:block;font-size:12px;">${esc(al.note)}</span>` : ''}
        </div>
        <div class="actions">
          <label class="chk" style="font-size:12px;">
            <input type="checkbox" class="al-toggle" ${al.enabled ? 'checked' : ''}> Bật
          </label>
          <button class="danger al-del" title="Xoá mục này">Xoá</button>
        </div>
      </li>`).join('');

    ul.querySelectorAll('.alert-item').forEach(li => {
      const id = li.dataset.id;
      li.querySelector('.al-toggle').addEventListener('change', async (e) => {
        const next = alerts.map(a => a.id === id ? { ...a, enabled: e.target.checked } : a);
        await saveSettings({ alerts: next });
      });
      li.querySelector('.al-del').addEventListener('click', async () => {
        const next = alerts.filter(a => a.id !== id);
        await saveSettings({ alerts: next });
      });
    });
  }

  // Render Lịch sử báo kèo
  const hist = S.alertHistory || [];
  const histUl = $('#alert-history');
  if (!hist.length) {
    histUl.innerHTML = '<li class="hint">Chưa có bài nào khớp kèo mong muốn. Extension sẽ tự động báo khi tìm thấy bài mới!</li>';
  } else {
    histUl.innerHTML = hist.slice(0, 30).map(h => `
      <li>
        <div>
          <strong>${esc(h.model)}</strong> — <span style="color:var(--accent);font-weight:600;">${A.fmtShort(h.price)}</span>
          (mức mong muốn: ${A.fmtShort(h.targetPrice)})
          <span class="sub" style="display:block;font-size:12px;">${esc(h.group || '')} · ${esc(h.author || 'ẩn danh')} · ${ago(h.time)}</span>
        </div>
        <a href="${esc(h.url)}" target="_blank" rel="noopener" class="button primary" style="padding:4px 10px;font-size:12px;">Xem bài</a>
      </li>`).join('');
  }
}

/* Xử lý form thêm theo dõi kèo */
$('#form-alert').addEventListener('submit', async (e) => {
  e.preventDefault();
  const category = $('#al-cat')?.value || 'CPU';
  const model = $('#al-model').value.trim();
  const rawPrice = $('#al-price').value.trim();
  const condition = $('#al-cond').value;
  const note = $('#al-note').value.trim();
  const maxPrice = A.parsePrice(rawPrice);

  if (!model || !maxPrice) {
    alert('Vui lòng nhập tên linh kiện và mức giá hợp lệ (vd: 2tr5 hoặc 2500000)');
    return;
  }

  const newAlert = {
    id: 'al_' + Date.now(),
    category,
    model,
    maxPrice,
    condition,
    note,
    enabled: true
  };

  const current = S.settings.alerts || [];
  await saveSettings({ alerts: [newAlert, ...current] });
  $('#form-alert').reset();
});

/* Render thông tin Tab Sao lưu & Dọn dẹp */
function renderBackupInfo() {
  const postsCount = Object.keys(S.posts).length;
  let textChars = 0;
  let oldPosts = 0;
  const cutoff = Date.now() - 90 * 864e5;

  for (const p of Object.values(S.posts)) {
    if (p.text) textChars += p.text.length;
    if (p.commentsText) textChars += p.commentsText.length;
    if (p.collectedAt < cutoff && p.text) oldPosts++;
  }

  const estKb = Math.round(textChars / 1024);
  $('#storage-summary').textContent =
    `Tổng số bài lưu trong máy: ${postsCount} bài (~${estKb} KB nội dung văn bản). Có ${oldPosts} bài cũ hơn 90 ngày có thể dọn dẹp văn bản gốc.`;
}

/* Nút Dọn dẹp bài cũ > 90 ngày */
$('#btn-prune-90').addEventListener('click', async () => {
  const cutoff = Date.now() - 90 * 864e5;
  const { posts = {} } = await chrome.storage.local.get('posts');
  let pruned = 0;
  for (const p of Object.values(posts)) {
    if (p.collectedAt < cutoff && p.text) {
      delete p.text;
      delete p.commentsText;
      p.pruned = true;
      pruned++;
    }
  }
  await chrome.storage.local.set({ posts });
  alert(`Đã dọn dẹp văn bản gốc của ${pruned} bài cũ hơn 90 ngày. Toàn bộ lịch sử giá và biểu đồ vẫn được giữ nguyên!`);
  load();
});

/* Xuất file JSON sao lưu */
function exportJSON() {
  const payload = {
    version: '0.4.0',
    exportedAt: Date.now(),
    posts: S.posts,
    settings: S.settings,
    stats: S.stats,
    alertHistory: S.alertHistory
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sao-luu-cpu-tracker-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
$('#btn-backup').addEventListener('click', exportJSON);
$('#btn-export-json').addEventListener('click', exportJSON);

/* Nhập file JSON khôi phục */
$('#file-import-json').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const statusEl = $('#import-status');
  statusEl.textContent = 'Đang đọc file sao lưu…';

  const reader = new FileReader();
  reader.onload = async (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!data.posts || typeof data.posts !== 'object') {
        throw new Error('File JSON không đúng cấu trúc của CPU Facebook Tracker.');
      }
      const existing = (await chrome.storage.local.get('posts')).posts || {};
      const mergedPosts = { ...existing, ...data.posts };
      const mergedSettings = { ...DEFAULTS, ...(S.settings || {}), ...(data.settings || {}) };
      await chrome.storage.local.set({
        posts: mergedPosts,
        settings: mergedSettings,
        alertHistory: data.alertHistory || S.alertHistory
      });
      statusEl.textContent = `Khôi phục thành công! Đã nạp ${Object.keys(data.posts).length} bài từ file sao lưu.`;
      load();
    } catch (err) {
      statusEl.textContent = `Lỗi nhập file: ${err.message}`;
    }
  };
  reader.readAsText(file);
});

/* Render nhật ký thu thập */
const LOG_LABEL = {
  saved: 'Đã lưu',
  nocpu: 'Không có linh kiện',
  nohardware: 'Không có linh kiện',
  crosspost: 'Bài đăng chéo',
  failed: 'Lỗi',
  paused: 'Tự dừng'
};
function renderLog() {
  const ul = $('#log');
  if (!S.log.length) { ul.innerHTML = '<li class="hint">Chưa mở bài nào.</li>'; return; }
  ul.innerHTML = S.log.slice(0, 50).map(e => `
    <li>
      <span class="st ${e.status}">${LOG_LABEL[e.status] || e.status}</span>
      ${esc(ago(e.t))} · ${esc(e.group || 'Nhóm không rõ')}
      ${e.models ? ' · ' + esc(e.models) : ''}
      ${e.detail ? ' · <strong style="color:' + (e.status === 'crosspost' ? '#6941c6' : 'var(--danger)') + ';">' + esc(e.detail) + '</strong>' : ''}
      ${e.url ? ` · <a href="${esc(e.url)}" target="_blank" rel="noopener">Mở bài</a>` : ''}
      ${e.status !== 'failed' && e.status !== 'paused' ? `<span class="sn" title="${esc(e.snippet)}">${e.textLen ? `Đọc được ${e.textLen} ký tự: ` : ''}${esc(e.snippet) || '(trống)'}</span>` : ''}
    </li>`).join('');
}

/* Cài đặt cấu hình */
function renderSettings() {
  const s = S.settings;
  const set = (id, v, prop = 'value') => { const el = $(id); if (el && document.activeElement !== el) el[prop] = v; };
  set('#s-auto', s.autoOpenWatcher, 'checked');
  set('#s-kw', s.keywordFilter, 'checked');
  set('#s-crosspost', s.filterCrossPosts !== false, 'checked');
  set('#s-reload', s.reloadMinutes);
  set('#s-gap', s.minGapSec);
  set('#s-max', s.maxPerHour);
  set('#s-max-err', s.maxConsecutiveErrors || 5);
  set('#s-dedup-hours', s.dedupHours || 48);
}
async function saveSettings(patchObj) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...DEFAULTS, ...settings, ...patchObj } });
}

$('#s-auto').addEventListener('change', e => saveSettings({ autoOpenWatcher: e.target.checked }));
$('#s-kw').addEventListener('change', e => saveSettings({ keywordFilter: e.target.checked }));
$('#s-crosspost').addEventListener('change', e => saveSettings({ filterCrossPosts: e.target.checked }));
$('#s-reload').addEventListener('change', e => saveSettings({ reloadMinutes: Math.max(1, +e.target.value || 3) }));
$('#s-gap').addEventListener('change', e => saveSettings({ minGapSec: Math.max(3, +e.target.value || 8) }));
$('#s-max').addEventListener('change', e => saveSettings({ maxPerHour: Math.max(5, +e.target.value || 60) }));
$('#s-max-err').addEventListener('change', e => saveSettings({ maxConsecutiveErrors: Math.max(2, +e.target.value || 5) }));
$('#s-dedup-hours').addEventListener('change', e => saveSettings({ dedupHours: Math.max(12, +e.target.value || 48) }));

async function checkWatcher() {
  const tabs = await chrome.tabs.query({ url: 'https://www.facebook.com/notifications*' });
  const w = $('#warn');
  if (tabs.length || !S.settings.enabled) { w.hidden = true; return; }
  w.hidden = false;
  w.innerHTML = 'Chưa có tab thông báo Facebook nào đang mở nên extension chưa gom được link bài. <button id="w-open" class="primary">Mở ngay</button>';
  $('#w-open').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'OPEN_WATCHER' }));
}

/* Xử lý các nút bấm trên thanh tiêu đề */
$('#btn-watch').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'OPEN_WATCHER' }));

$('#btn-toggle').addEventListener('click', async () => {
  const next = !S.settings.enabled;
  await saveSettings({ enabled: next });
  if (next) {
    await chrome.runtime.sendMessage({ type: 'RESUME_COLLECTION' });
  }
  chrome.runtime.sendMessage({ type: 'PUMP' });
});

$('#btn-resume-safe').addEventListener('click', async () => {
  await saveSettings({ enabled: true });
  await chrome.runtime.sendMessage({ type: 'RESUME_COLLECTION' });
});

$('#btn-clear').addEventListener('click', async () => {
  if (!confirm('Xoá toàn bộ bài đã thu thập và hàng đợi? Không thể hoàn tác.')) return;
  await chrome.storage.local.set({ posts: {}, queue: [], seen: {}, recentSnippets: {}, stats: {}, log: [], alertHistory: [] });
  load();
});

$('#btn-csv').addEventListener('click', () => {
  const head = ['Thời gian', 'Mẫu CPU', 'Giá (đ)', 'Tình trạng', 'Trạng thái', 'Loại tin', 'Lặp 48h', 'Giá ảo', 'Cần kiểm tra', 'Người đăng', 'Nhóm', 'Link bài'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = rows().map(r => [
    new Date(r.at).toISOString(),
    r.model,
    r.price ?? '',
    COND[r.condition],
    r.isSold ? 'Đã bán' : 'Đang rao',
    TYPE[r.priceType],
    r.isDuplicate ? 'Lặp' : 'Không',
    r.isOutlier ? 'Ảo' : 'Không',
    r.needsReview ? 'Có' : 'Không',
    r.author || '',
    r.group,
    r.url
  ].map(q).join(','));
  const blob = new Blob(['\ufeff' + [head.map(q).join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `gia-cpu-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

/* Chuyển đổi qua lại các Tab */
$$('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.tab-btn').forEach(b => b.classList.remove('active'));
    $$('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    const target = $(`#${btn.dataset.tab}`);
    if (target) target.classList.add('active');
  });
});

/* Lắng nghe thay đổi bộ lọc */
['#f-cat', '#f-range', '#f-cond', '#f-sold', '#f-dedup', '#f-crosspost', '#f-outlier'].forEach(id => {
  const el = $(id);
  if (el) el.addEventListener('change', render);
});
$('#f-q').addEventListener('input', render);

load();
setInterval(render, 60000);
