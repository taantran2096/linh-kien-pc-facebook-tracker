/* background.js — v0.5.1 — Hàng đợi + kiểm soát tab an toàn + cảnh báo kèo + chống spam */
importScripts('analyzer.js');

const WATCH_URL = 'https://www.facebook.com/notifications';
const DEFAULTS = {
  enabled: true,
  autoOpenWatcher: true,     // tự mở và ghim tab thông báo Facebook
  reloadMinutes: 3,          // tải lại tab thông báo định kỳ
  minGapSec: 8,              // giãn cách tối thiểu giữa 2 lần mở bài
  maxPerHour: 60,            // tối đa số bài mở mỗi giờ
  keywordFilter: false,      // true: chỉ mở khi đoạn trích thông báo có từ khoá linh kiện
  filterCrossPosts: true,    // true: tự động phát hiện và chặn mở bài đăng chéo nhiều nhóm (Cross-post)
  maxConsecutiveErrors: 5,   // tự dừng khi gặp 5 lỗi liên tiếp để bảo vệ tài khoản
  dedupHours: 48,            // gộp bài lặp cùng người đăng, mẫu, giá trong 48 giờ
  filterOutliers: true,      // lọc giá bất thường khỏi thống kê
  autoPruneDays: 90,         // xoá nội dung gốc bài cũ hơn 90 ngày để nhẹ máy
  alerts: []                 // danh sách theo dõi kèo mong muốn: [{ id, model, maxPrice, condition, enabled }]
};

let chain = Promise.resolve();
const serial = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };

async function getState() {
  const s = await chrome.storage.local.get([
    'settings', 'queue', 'active', 'opened', 'posts', 'seen', 'recentSnippets', 'stats', 'lastReload',
    'consecutiveErrors', 'pauseReason', 'alertHistory'
  ]);
  return {
    settings: { ...DEFAULTS, ...(s.settings || {}) },
    queue: s.queue || [],
    active: s.active || null,
    opened: s.opened || [],
    posts: s.posts || {},
    seen: s.seen || {},
    recentSnippets: s.recentSnippets || {},
    stats: { skipped: 0, failed: 0, collected: 0, lastCollectedAt: 0, ...(s.stats || {}) },
    lastReload: s.lastReload || 0,
    consecutiveErrors: s.consecutiveErrors || 0,
    pauseReason: s.pauseReason || null,
    alertHistory: s.alertHistory || []
  };
}
const save = (obj) => chrome.storage.local.set(obj);

async function addLog(entry) {
  const { log = [] } = await chrome.storage.local.get('log');
  log.unshift({ t: Date.now(), ...entry });
  await chrome.storage.local.set({ log: log.slice(0, 100) });
}

function parsePost(rawUrl) {
  let u = rawUrl;
  try { u = decodeURIComponent(rawUrl); } catch (e) {}
  let m = u.match(/\/groups\/([\w.\-]+)\/(?:posts|permalink)\/(\d+)/);
  if (!m) m = u.match(/\/groups\/([\w.\-]+)\/?\?[^#]*multi_permalinks=(\d+)/);
  if (!m) return null;
  return { key: `${m[1]}_${m[2]}`, url: `https://www.facebook.com/groups/${m[1]}/posts/${m[2]}/` };
}

/* ---------- Tính bảng trung vị tham chiếu để phát hiện outlier ---------- */
function buildMedianMap(posts) {
  const map = new Map();
  for (const p of Object.values(posts)) {
    for (const l of (p.listings || [])) {
      if (l.priceType === 'sell' && l.price && !l.isSold && !l.needsReview) {
        if (!map.has(l.model)) map.set(l.model, []);
        map.get(l.model).push(l.price);
      }
    }
  }
  const result = {};
  for (const [model, prices] of map.entries()) {
    if (prices.length >= 3) {
      const sm = CPUAnalyzer.summarize(prices);
      if (sm) result[model] = sm.median;
    }
  }
  return result;
}

/* ---------- Tự động tạm dừng khẩn cấp (bảo vệ tài khoản) ---------- */
async function triggerAutoPause(reason) {
  await serial(async () => {
    const st = await getState();
    st.settings.enabled = false;
    st.pauseReason = reason;
    await save({ settings: st.settings, pauseReason: reason });
    await addLog({ status: 'paused', detail: reason });
    if (st.active && st.active.tabId) {
      const tid = st.active.tabId;
      st.active = null;
      await save({ active: null });
      chrome.tabs.remove(tid).catch(() => {});
    }
  });
  updateBadge();
  try {
    chrome.notifications.create('cpu_paused_' + Date.now(), {
      type: 'basic',
      iconUrl: 'icon-128.png',
      title: 'Tự động tạm dừng Linh Kiện PC Tracker',
      message: `${reason}. Extension tạm dừng để tránh rủi ro tài khoản.`,
      priority: 2
    });
  } catch (e) {}
}

/* ---------- Nhận dữ liệu từ content script ---------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === 'NOTIF_LINKS') {
      await serial(async () => {
        const st = await getState();
        if (!st.settings.enabled) return;
        let changed = false;
        const cutoff = Date.now() - (st.settings.dedupHours || 48) * 3600 * 1000;

        for (const it of msg.items || []) {
          const p = parsePost(it.url);
          if (!p || st.seen[p.key] || st.posts[p.key]) continue;

          // 1. Lọc theo từ khóa linh kiện nếu bật
          if (st.settings.keywordFilter && !(CPUAnalyzer.looksLikeHardware ? CPUAnalyzer.looksLikeHardware(it.preview || '') : CPUAnalyzer.looksLikeCpu(it.preview || ''))) {
            st.seen[p.key] = Date.now();
            changed = true;
            continue;
          }

          // 2. Lọc Cross-post ngay từ thông báo (không mở tab, tiết kiệm CPU và tránh checkpoint)
          if (st.settings.filterCrossPosts !== false) {
            const fp = CPUAnalyzer.getSnippetFingerprint ? CPUAnalyzer.getSnippetFingerprint(it.preview) : '';
            if (fp) {
              const existing = st.recentSnippets && st.recentSnippets[fp];
              if (existing && existing.at > cutoff && existing.key !== p.key) {
                // Đã thấy bài đăng chéo này ở nhóm khác
                st.seen[p.key] = Date.now();
                changed = true;
                await addLog({
                  status: 'crosspost',
                  url: p.url,
                  group: it.groupName,
                  detail: `Bỏ qua đăng chéo (Cross-post): trùng nội dung với bài tại "${existing.groupName || 'nhóm khác'}"`,
                  textLen: (it.preview || '').length,
                  snippet: (it.preview || '').slice(0, 160)
                });
                continue;
              }

              if (!st.recentSnippets) st.recentSnippets = {};
              st.recentSnippets[fp] = {
                key: p.key,
                groupName: it.groupName || '',
                url: p.url,
                at: Date.now()
              };
            }
          }

          st.seen[p.key] = Date.now();
          st.queue.push({
            key: p.key,
            url: p.url,
            preview: (it.preview || '').slice(0, 300),
            groupName: it.groupName || '',
            tries: 0,
            addedAt: Date.now()
          });
          changed = true;
        }
        if (changed) await save({
          queue: st.queue,
          seen: pruneSeen(st.seen),
          recentSnippets: pruneSnippets(st.recentSnippets)
        });
      });
      pump();
      sendResponse({ ok: true });
    } else if (msg.type === 'IS_QUEUED') {
      const st = await getState();
      const mine = !!(st.active && sender.tab && st.active.tabId === sender.tab.id);
      sendResponse({ ok: mine, key: mine ? st.active.key : '', url: mine ? st.active.url : '' });
    } else if (msg.type === 'POST_CONTENT') {
      await finishActive(sender.tab && sender.tab.id, msg);
      sendResponse({ ok: true });
    } else if (msg.type === 'POST_FAILED') {
      await failActive(sender.tab && sender.tab.id, msg.reason || 'lỗi');
      sendResponse({ ok: true });
    } else if (msg.type === 'SECURITY_CHECK_DETECTED') {
      // Nhận diện màn hình bảo mật / checkpoint / bắt login từ tab
      await triggerAutoPause(msg.reason || 'Phát hiện trang đăng nhập hoặc kiểm tra bảo mật (Checkpoint) Facebook');
      sendResponse({ ok: true });
    } else if (msg.type === 'OPEN_WATCHER') {
      await ensureWatcher(true);
      sendResponse({ ok: true });
    } else if (msg.type === 'PUMP') {
      pump();
      sendResponse({ ok: true });
    } else if (msg.type === 'RESUME_COLLECTION') {
      // Người dùng bấm tiếp tục thu thập: reset lỗi liên tiếp
      await save({ consecutiveErrors: 0, pauseReason: null });
      pump();
      sendResponse({ ok: true });
    }
  })();
  return true;
});

function pruneSeen(seen) {
  const keys = Object.keys(seen);
  if (keys.length < 5000) return seen;
  const cutoff = Date.now() - 14 * 864e5;
  for (const k of keys) if (seen[k] < cutoff) delete seen[k];
  return seen;
}

function pruneSnippets(snippets) {
  if (!snippets) return {};
  const keys = Object.keys(snippets);
  if (keys.length < 2000) return snippets;
  const cutoff = Date.now() - 7 * 864e5;
  for (const k of keys) if (snippets[k].at < cutoff) delete snippets[k];
  return snippets;
}

/* ---------- Lưu kết quả một bài viết ---------- */
async function finishActive(tabId, msg) {
  let matchedAlerts = [];
  let keyMismatch = false;
  await serial(async () => {
    const st = await getState();
    if (!st.active || st.active.tabId !== tabId) return;
    const a = st.active;

    // Nội dung do tab gửi về phải đúng bài đang xử lý
    if (msg.key && msg.key !== a.key) { keyMismatch = true; return; }

    // Reset chuỗi lỗi liên tiếp khi có bài đọc thành công
    st.consecutiveErrors = 0;
    st.pauseReason = null;

    const medianMap = buildMedianMap(st.posts);
    // Chỉ tách linh kiện/giá từ NỘI DUNG BÀI. Bình luận (của chính người đăng) chỉ dùng để nhận biết "đã bán".
    const postOnly = (msg.postText || msg.text || '').trim();
    const res = CPUAnalyzer.analyze(postOnly, { medianMap });
    if (msg.commentsText && CPUAnalyzer.detectSold(msg.commentsText) &&
        new Set(res.listings.map(l => l.model)).size <= 2) {
      res.listings.forEach(l => { l.isSold = true; });
    }

    if (res.hasHardware || res.hasCpu) {
      const dedupCutoff = Date.now() - (st.settings.dedupHours || 48) * 3600 * 1000;
      const authorClean = (msg.author || '').trim().toLowerCase();

      // Kiểm tra Cross-post sâu dựa trên nội dung bài viết và tác giả
      let isCrossPost = false;
      let crossPostOriginalGroup = '';
      let crossPostOriginalUrl = '';

      const contentFp = CPUAnalyzer.getContentFingerprint ? CPUAnalyzer.getContentFingerprint(msg.text) : '';
      if (contentFp && st.settings.filterCrossPosts !== false) {
        for (const [postKey, p] of Object.entries(st.posts)) {
          if (postKey === a.key || p.collectedAt < dedupCutoff) continue;
          const otherFp = CPUAnalyzer.getContentFingerprint ? CPUAnalyzer.getContentFingerprint(p.text) : '';
          const sameAuthor = authorClean && (p.author || '').trim().toLowerCase() === authorClean;

          if ((contentFp && otherFp && contentFp === otherFp) || (sameAuthor && (contentFp === otherFp || (contentFp.length >= 40 && contentFp.slice(0, 80) === otherFp.slice(0, 80))))) {
            isCrossPost = true;
            crossPostOriginalGroup = p.groupName || 'Nhóm khác';
            crossPostOriginalUrl = p.url;
            break;
          }
        }
      }

      // Kiểm tra trùng lặp (Deduplication) theo người đăng + model + giá trong 48h
      res.listings.forEach(l => {
        if (isCrossPost) {
          l.isDuplicate = true;
          l.isCrossPost = true;
          l.duplicateGroup = crossPostOriginalGroup;
          l.duplicateUrl = crossPostOriginalUrl;
        }
        if (!l.price || !authorClean) return;
        for (const [postKey, p] of Object.entries(st.posts)) {
          if (postKey === a.key || p.collectedAt < dedupCutoff) continue;
          if ((p.author || '').trim().toLowerCase() !== authorClean) continue;
          const dup = (p.listings || []).some(x => x.model === l.model && x.price === l.price);
          if (dup) {
            l.isDuplicate = true;
            l.duplicateGroup = p.groupName || 'Nhóm khác';
            l.duplicateUrl = p.url;
            break;
          }
        }
      });

      // Kiểm tra danh sách theo dõi kèo mong muốn (Wishlist alerts)
      const alerts = (st.settings.alerts || []).filter(al => al.enabled);
      res.listings.forEach(l => {
        if (l.priceType !== 'sell' || l.isSold || l.needsReview || l.isOutlier || !l.price || l.isCrossPost) return;
        for (const al of alerts) {
          const matchModel = l.model.toLowerCase() === al.model.toLowerCase();
          const matchPrice = l.price <= al.maxPrice;
          const matchCond = !al.condition || l.condition === al.condition;
          if (matchModel && matchPrice && matchCond) {
            matchedAlerts.push({
              id: 'alert_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
              model: l.model,
              price: l.price,
              targetPrice: al.maxPrice,
              condition: l.condition,
              url: a.url,
              group: a.groupName,
              author: msg.author,
              time: Date.now()
            });
          }
        }
      });

      const cleanPostText = (msg.postText || msg.text || '').trim();
      st.posts[a.key] = {
        key: a.key,
        url: a.url,
        groupName: a.groupName,
        author: msg.author || '',
        text: cleanPostText.slice(0, 6000),
        commentsText: (msg.commentsText || '').slice(0, 3000),
        imageCount: msg.imageCount || 0,
        preview: a.preview,
        collectedAt: Date.now(),
        listings: res.listings,
        isCrossPost: isCrossPost,
        crossPostOriginalGroup: isCrossPost ? crossPostOriginalGroup : undefined,
        crossPostOriginalUrl: isCrossPost ? crossPostOriginalUrl : undefined
      };
      st.stats.collected++;
      st.stats.lastCollectedAt = Date.now();
    } else {
      st.stats.skipped++;
    }

    // Tự động dọn dẹp nội dung gốc cũ hơn 90 ngày (giữ số liệu giá)
    if (st.settings.autoPruneDays > 0) {
      const pruneCutoff = Date.now() - st.settings.autoPruneDays * 864e5;
      for (const p of Object.values(st.posts)) {
        if (p.collectedAt < pruneCutoff && p.text) {
          delete p.text;
          delete p.commentsText;
          p.pruned = true;
        }
      }
    }

    if (matchedAlerts.length) {
      st.alertHistory = [...matchedAlerts, ...(st.alertHistory || [])].slice(0, 50);
    }

    await save({
      posts: st.posts,
      stats: st.stats,
      active: null,
      consecutiveErrors: 0,
      pauseReason: null,
      alertHistory: st.alertHistory
    });

    const isCrossPost = st.posts[a.key]?.isCrossPost;
    const originalGroup = st.posts[a.key]?.crossPostOriginalGroup;
    const cleanPostText = (msg.postText || msg.text || '').trim();
    const norm = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const pv = norm(CPUAnalyzer.getSnippetFingerprint ? CPUAnalyzer.getSnippetFingerprint(a.preview) : '').slice(0, 30);
    const previewMismatch = pv.length >= 18 && !norm(cleanPostText).includes(pv);
    await addLog({
      status: isCrossPost ? 'crosspost' : ((res.hasHardware || res.hasCpu) ? 'saved' : 'nocpu'),
      url: a.url,
      group: a.groupName,
      models: res.listings.map(l => `${l.model} (${l.isSold ? 'đã bán' : CPUAnalyzer.fmtShort(l.price)})`).join(', '),
      detail: isCrossPost
        ? `Bài đăng chéo (Cross-post): trùng nội dung với bài tại "${originalGroup || 'nhóm khác'}"`
        : (previewMismatch ? 'Lưu ý: nội dung đọc được không khớp đoạn trích thông báo (có thể bài đã sửa/đọc sai)' : undefined),
      textLen: cleanPostText.length,
      snippet: cleanPostText.replace(/\s+/g, ' ').slice(0, 160)
    });

    chrome.tabs.remove(tabId).catch(() => {});
  });

  if (keyMismatch) {
    await failActive(tabId, 'Nội dung trang không khớp bài trong hàng đợi');
    return;
  }

  // Bắn thông báo Chrome cho người dùng khi có kèo thơm
  matchedAlerts.forEach(hit => {
    try {
      chrome.notifications.create(hit.id, {
        type: 'basic',
        iconUrl: 'icon-128.png',
        title: `🔥 KÈO THƠM: ${hit.model} giá ${CPUAnalyzer.fmtShort(hit.price)}!`,
        message: `Rẻ hơn mức mong muốn ${CPUAnalyzer.fmtShort(hit.targetPrice)} tại ${hit.group || 'nhóm Facebook'}. Bấm để xem bài ngay!`,
        priority: 2
      });
    } catch (e) {}
  });

  updateBadge();
  setTimeout(pump, 1500);
}

/* Bấm vào thông báo Chrome sẽ mở trực tiếp link bài viết */
chrome.notifications.onClicked.addListener(async (notifId) => {
  const { alertHistory = [] } = await chrome.storage.local.get('alertHistory');
  const hit = alertHistory.find(h => h.id === notifId);
  if (hit && hit.url) {
    chrome.tabs.create({ url: hit.url, active: true });
  }
});

/* ---------- Xử lý khi bài bị lỗi ---------- */
async function failActive(tabId, reason) {
  let shouldPause = false;
  let pauseMessage = '';
  await serial(async () => {
    const st = await getState();
    if (!st.active || (tabId != null && st.active.tabId !== tabId)) return;
    const a = st.active;

    if (a.tries + 1 < 2) {
      st.queue.push({ ...a.item, tries: a.tries + 1 });
    } else {
      st.stats.failed++;
      st.consecutiveErrors = (st.consecutiveErrors || 0) + 1;
      const maxErr = st.settings.maxConsecutiveErrors || 5;
      if (st.consecutiveErrors >= maxErr) {
        shouldPause = true;
        pauseMessage = `Đã gặp ${st.consecutiveErrors} lỗi liên tiếp`;
      }
    }

    await save({
      queue: st.queue,
      stats: st.stats,
      active: null,
      consecutiveErrors: st.consecutiveErrors
    });

    await addLog({
      status: 'failed',
      url: a.url,
      group: a.groupName,
      detail: reason,
      tries: a.tries + 1,
      consecutiveErrors: st.consecutiveErrors
    });

    chrome.tabs.remove(a.tabId).catch(() => {});
  });

  if (shouldPause) {
    await triggerAutoPause(pauseMessage);
  } else {
    updateBadge();
  }
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const st = await getState();
  if (st.active && st.active.tabId === tabId) {
    await failActive(tabId, 'Tab bị đóng trước khi đọc xong');
  }
});

/* ---------- Bơm hàng đợi ---------- */
async function pumpInner() {
  const st = await getState();
  const S = st.settings;
  if (!S.enabled) return;
  const now = Date.now();

  if (st.active) {
    if (now - st.active.startedAt > 60000) {
      const a = st.active;
      if (a.tries + 1 < 2) {
        st.queue.push({ ...a.item, tries: a.tries + 1 });
      } else {
        st.stats.failed++;
        st.consecutiveErrors = (st.consecutiveErrors || 0) + 1;
      }
      chrome.tabs.remove(a.tabId).catch(() => {});
      st.active = null;
      await save({ queue: st.queue, stats: st.stats, active: null, consecutiveErrors: st.consecutiveErrors });
      await addLog({
        status: 'failed',
        url: a.url,
        group: a.groupName,
        detail: 'Quá 60 giây, content script không phản hồi',
        tries: a.tries + 1
      });
      if (st.consecutiveErrors >= (S.maxConsecutiveErrors || 5)) {
        await triggerAutoPause(`Gặp ${st.consecutiveErrors} bài treo/lỗi liên tiếp`);
        return;
      }
    } else {
      return;
    }
  }
  if (!st.queue.length) return;

  st.opened = st.opened.filter(t => now - t < 3600e3);
  if (st.opened.length >= S.maxPerHour) return;
  const last = st.opened[st.opened.length - 1] || 0;
  const gap = S.minGapSec * 1000 + Math.random() * 4000;
  if (now - last < gap) {
    setTimeout(pump, gap - (now - last) + 200);
    return;
  }

  const item = st.queue.shift();
  let tab;
  try {
    tab = await chrome.tabs.create({ url: item.url + '?cpt=1', active: false });
  } catch (e) {
    st.queue.push(item);
    await save({ queue: st.queue });
    return;
  }
  st.opened.push(now);
  await save({
    queue: st.queue,
    opened: st.opened,
    active: {
      key: item.key,
      url: item.url,
      groupName: item.groupName,
      preview: item.preview,
      tabId: tab.id,
      startedAt: now,
      tries: item.tries || 0,
      item
    }
  });
}
const pump = () => serial(pumpInner).then(updateBadge).catch(() => {});

/* ---------- Quản lý tab thông báo ---------- */
async function ensureWatcher(force) {
  const st = await getState();
  if (!force && (!st.settings.enabled || !st.settings.autoOpenWatcher)) return;
  const tabs = await chrome.tabs.query({ url: 'https://www.facebook.com/notifications*' });
  if (!tabs.length) {
    await chrome.tabs.create({ url: WATCH_URL, pinned: true, active: !!force });
    await save({ lastReload: Date.now() });
    return;
  }
  if (force) {
    chrome.tabs.update(tabs[0].id, { active: true });
    return;
  }
  if (Date.now() - st.lastReload > st.settings.reloadMinutes * 60000) {
    chrome.tabs.reload(tabs[0].id).catch(() => {});
    await save({ lastReload: Date.now() });
  }
}

/* ---------- Cập nhật huy hiệu icon biểu tượng extension ---------- */
async function updateBadge() {
  const st = await getState();
  if (st.pauseReason) {
    chrome.action.setBadgeBackgroundColor({ color: '#dc2626' }); // Đỏ cảnh báo khi tạm dừng do lỗi/checkpoint
    chrome.action.setBadgeText({ text: 'ERR' });
    return;
  }
  if (!st.settings.enabled) {
    chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
    chrome.action.setBadgeText({ text: 'II' });
    return;
  }
  const n = st.queue.length + (st.active ? 1 : 0);
  chrome.action.setBadgeBackgroundColor({ color: '#0f766e' });
  chrome.action.setBadgeText({ text: n ? String(n) : '' });
}

/* ---------- Báo thức & Sự kiện ---------- */
async function setupAlarm() {
  const a = await chrome.alarms.get('tick');
  if (!a) chrome.alarms.create('tick', { periodInMinutes: 0.5 });
}
chrome.alarms.onAlarm.addListener(async (al) => {
  if (al.name !== 'tick') return;
  await ensureWatcher(false);
  pump();
});
chrome.runtime.onInstalled.addListener(() => { setupAlarm(); ensureWatcher(false); updateBadge(); });
chrome.runtime.onStartup.addListener(() => { setupAlarm(); ensureWatcher(false); updateBadge(); });
chrome.storage.onChanged.addListener((ch) => { if (ch.settings || ch.pauseReason) updateBadge(); });
setupAlarm();

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('dashboard.html');
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length) {
    chrome.tabs.update(tabs[0].id, { active: true });
    chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    chrome.tabs.create({ url });
  }
});
