/* analyzer.js — v0.5.0 — Phân tích bài đăng mua bán linh kiện PC Facebook
 * Hỗ trợ đa linh kiện: CPU, VGA (Card màn hình), Mainboard (Bo mạch chủ), RAM, SSD / NVMe
 * Tính năng:
 * - Nhận diện "ĐÃ BÁN", "hết", "sold", "đã bay", "có gạch"
 * - Phân loại danh mục: 'CPU' | 'VGA' | 'Main' | 'RAM' | 'SSD'
 * - Phát hiện giá bất thường (outlier / gõ nhầm giá)
 * - Phát hiện bài đăng lặp (Deduplication trong 48h)
 * - Tính xu hướng giá so với tuần trước
 */
const HardwareAnalyzer = (() => {
  // Bảng tra cứu AMD Ryzen & Athlon
  const AMD_TABLE = {
    '200GE': 'Athlon', '3000G': 'Athlon',
    '1200': 3, '1300X': 3, '2200G': 3, '3100': 3, '3200G': 3, '3300X': 3, '4100': 3, '4300G': 3, '5300G': 3,
    '1600': 5, '1600X': 5, '2600': 5, '2600X': 5,
    '3600': 5, '3600X': 5, '4500': 5, '4600G': 5,
    '5500': 5, '5600': 5, '5600G': 5, '5600GT': 5, '5600X': 5, '5600X3D': 5,
    '7500F': 5, '7600': 5, '7600X': 5, '7600X3D': 5,
    '8400F': 5, '8500G': 5, '8600G': 5,
    '9600X': 5,
    '1700': 7, '1700X': 7, '1800X': 7, '2700': 7, '2700X': 7,
    '3700X': 7, '3800X': 7,
    '5700': 7, '5700G': 7, '5700X': 7, '5700X3D': 7, '5800X': 7, '5800X3D': 7, '5800XT': 7,
    '7700': 7, '7700X': 7, '7800X3D': 7,
    '8700F': 7, '8700G': 7,
    '9700X': 7, '9800X3D': 7,
    '3900X': 9, '3950X': 9,
    '5900X': 9, '5900XT': 9, '5950X': 9,
    '7900': 9, '7900X': 9, '7900X3D': 9, '7950X': 9, '7950X3D': 9,
    '9900X': 9, '9900X3D': 9, '9950X': 9, '9950X3D': 9,
    '1950X': 'TR', '2950X': 'TR', '3960X': 'TR', '3970X': 'TR', '5975WX': 'TR'
  };

  const INTEL_TIER = { 1: 3, 3: 3, 4: 5, 5: 5, 6: 5, 7: 7, 9: 9 };
  const PRICE_MIN = 120000, PRICE_MAX = 90000000;

  // Từ khoá phân loại ý định & trạng thái
  const BUY = /(cần mua|cần tìm|cần kiếm|tìm mua|thu mua|nhận mua|mua gấp|mua lại|(?<![a-z])wtb(?![a-z])|ai có|ai bán|bank tiền|cần ship|cần cod|bác nào có)/iu;
  const SELL = /(cần bán|(?<![\p{L}])bán(?![\p{L}])|(?<![a-z])pass(?![a-z])|nhượng|thanh lý|(?<![\p{L}])xả(?![\p{L}])|(?<![a-z])wts(?![a-z])|giao lưu|lên đời|ra đi|sale|cần tiền|dọn nhà|dọn kho|dư dùng|chạy phà|còn dư|hàng sẵn)/iu;
  const INBOX = /(inbox|(?<![a-z])ib(?![a-z])|(?<![a-z])pm(?![a-z])|liên hệ|nhắn tin|nhắn riêng|giá (?:cmt|comment|bình luận|trong)|(?<![a-z])cmt(?![a-z])|comment|(?<![a-z])lh(?![a-z])|zalo|check giá)/iu;
  const COMBO_KW = /(combo|(?<![a-z])cb(?![a-z])|trọn bộ|full bộ|nguyên bộ|bộ pc|bộ máy|cả dàn|dàn máy)/iu;
  const USED = /(like ?new|(?<!\d)9[5-9] ?%|mới 9[5-9]|qua sử dụng|đã qua|đã dùng|đã sử dụng|(?<![\p{L}])cũ(?![\p{L}])|(?<![a-z])used(?![a-z])|second ?hand|(?<![a-z\d])2nd(?![a-z\d])|hàng lướt|(?<![\p{L}])lướt(?![\p{L}])|bóc seal|hết bảo hành|hbh|bao test)/iu;
  const TRAY = /((?<![a-z])(?:new ?)?tray(?![a-z])|không box|ko box|không hộp|ko hộp|mất box)/iu;
  const SEALED = /(new ?seal|nguyên ?seal|mới 100|new 100|mới keng|chưa (?:bóc|kích hoạt|sử dụng)|(?<![a-z])sealed(?![a-z])|(?<![a-z])new(?![a-z])|chính hãng|còn seal)/iu;

  // Nhận diện bài đã bán / hết hàng / có gạch
  const SOLD = /(đã bán|hết hàng|hết r(?:ồi)?|đã bay|bay r(?:ồi)?|da ban|(?<![a-z])sold(?![a-z])|(?<![a-z])closed(?![a-z])|(?<![a-z])gạch(?![a-z])|có gạch|đang cọc|nhận cọc|đã cọc|(?<![a-z])done(?![a-z])|bay nhanh|xong rồi)/iu;

  const validIntel = (s) => {
    const n = +s;
    if (s.length === 4) return n >= 2000 && !(n >= 2019 && n <= 2030);
    return n >= 10000 && n <= 14999;
  };

  /**
   * Nhận diện các linh kiện trong từng dòng bài viết:
   * CPU, VGA, Mainboard, RAM, SSD/NVMe
   */
  function findModels(line) {
    const out = [];
    const overlaps = (a, b) => out.some(o => a < o.end && b > o.index);
    const push = (m, name, brand, category = 'CPU') => {
      const idx = m.index, end = idx + m[0].length;
      if (!overlaps(idx, end)) out.push({ name, brand, category, index: idx, end });
    };
    const cpuWord = /(cpu|vi xử lý|chip|intel|amd|ryzen|core|xeon|pentium|celeron)/i.test(line);
    let m;

    /* ==============================================================
     * 1. VGA / CARD ĐỒ HỌA (RTX, GTX, RX, ARC)
     * ============================================================== */
    // RTX 4090, 4080 Super, 4070 Ti Super, 4070 Super, 4060 Ti, 4060...
    // RTX 3090, 3080 Ti, 3070, 3060 Ti, 3050...
    // RTX 2080 Ti, 2070 Super, 2060 Super...
    const reRtx = /(?<![a-z\d])(?:vga\s|card\s)?rtx[\s\-]?([2345]\d{3})[\s\-]?(ti(?:\s?super)?|super)?(?![a-z\d])/gi;
    while ((m = reRtx.exec(line))) {
      const suf = m[2] ? ' ' + m[2].toUpperCase().replace(/\s+/, ' ') : '';
      push(m, `RTX ${m[1]}${suf}`, 'NVIDIA', 'VGA');
    }

    // GTX 1660 Ti, 1660 Super, 1650, 1080 Ti, 1070 Ti, 1060, 1050 Ti, 970, 750 Ti...
    const reGtx = /(?<![a-z\d])(?:vga\s|card\s)?gtx[\s\-]?(\d{3,4})[\s\-]?(ti(?:\s?super)?|super)?(?![a-z\d])/gi;
    while ((m = reGtx.exec(line))) {
      const suf = m[2] ? ' ' + m[2].toUpperCase() : '';
      push(m, `GTX ${m[1]}${suf}`, 'NVIDIA', 'VGA');
    }

    // AMD Radeon RX 7900 XTX/XT/GRE, RX 7800 XT, 7600, RX 6900 XT, 6800, 6700 XT, 6600, 6500 XT, RX 580, 570...
    const reRx = /(?<![a-z\d])(?:vga\s|card\s|radeon\s)?rx[\s\-]?([4567]\d{2,3})[\s\-]?(xtx|xt|gre)?(?![a-z\d])/gi;
    while ((m = reRx.exec(line))) {
      const suf = m[2] ? ' ' + m[2].toUpperCase() : '';
      push(m, `RX ${m[1]}${suf}`, 'AMD', 'VGA');
    }

    // Intel Arc (Arc A770, Arc A750, Arc A580, Arc A380)
    const reArc = /(?<![a-z\d])(?:intel\s)?arc[\s\-]?a([357]\d{2})(?![a-z\d])/gi;
    while ((m = reArc.exec(line))) {
      push(m, `Arc A${m[1]}`, 'Intel', 'VGA');
    }

    /* ==============================================================
     * 2. MAINBOARD (BO MẠCH CHỦ)
     * ============================================================== */
    // Chipset Intel: H61, H81, H110, H310, H410, H510, H610, B75, B85, B150, B250, B360, B365, B460, B560, B660, B760, Z87, Z97, Z170, Z270, Z370, Z390, Z490, Z590, Z690, Z790, Z890
    // Chipset AMD: A320, A520, A620, B350, B450, B550, B650, B650E, X370, X470, X570, X670, X670E, X870, X870E
    const reMain = /(?<![a-z\d])(?:main(?:board)?\s|bo mạch\s)?([abhzx]\d{2,3})(m)?[\s\-]?(mortar|tomahawk|aorus|tuf|rog|strix|steel\s?legend|pro4|pro(?:\-vdh)?|gaming\s?x|prime|ds3h|wifi|plus)?(?![a-z\d])/gi;
    while ((m = reMain.exec(line))) {
      const code = m[1].toUpperCase();
      // Loại bỏ các mã CPU hoặc mã khác trùng lặp số (như H410, B760, B650)
      const validChipset = /^(?:H[68]1|H110|H310|H410|H510|H610|B75|B85|B150|B250|B360|B365|B460|B560|B660|B760|Z87|Z97|Z170|Z270|Z370|Z390|Z490|Z590|Z690|Z790|Z890|A320|A520|A620|B350|B450|B550|B650|X370|X470|X570|X670|X870)$/i.test(code);
      if (validChipset) {
        const mForm = m[2] ? 'M' : '';
        const suf = m[3] ? ' ' + m[3].charAt(0).toUpperCase() + m[3].slice(1) : '';
        push(m, `Main ${code}${mForm}${suf}`, 'Mainboard', 'Main');
      }
    }

    /* ==============================================================
     * 3. RAM (BỘ NHỚ TRONG)
     * ============================================================== */
    // RAM DDR4 16GB, RAM 32GB (2x16GB) D5 6000, 8GB DDR4 bus 3200, 16G DDR4...
    const reRam = /(?<![a-z\d])(?:ram\s|kit\s)?(?:(\d{1,2})\s?(?:x\s?|\*\s?))?(\d{1,2})\s?g(?:b)?[\s\-]?(?:ddr([345])|d([345]))?[\s\-]?(?:bus\s?)?(\d{4})?(?![a-z\d])/gi;
    while ((m = reRam.exec(line))) {
      // Chỉ nhận diện là RAM nếu có chữ 'ram', 'kit' hoặc kèm ddr/bus
      const isExplicitRam = /(?:ram|kit|ddr|bus)/i.test(line.slice(Math.max(0, m.index - 15), Math.min(line.length, m.index + m[0].length + 15)));
      if (isExplicitRam) {
        const count = m[1] ? `${m[1]}x` : '';
        const cap = m[2];
        if (['4', '8', '16', '32', '64'].includes(cap)) {
          const gen = m[3] || m[4] ? `DDR${m[3] || m[4]}` : 'DDR4';
          const bus = m[5] ? ` ${m[5]}MHz` : '';
          push(m, `RAM ${count}${cap}GB ${gen}${bus}`, 'RAM', 'RAM');
        }
      }
    }

    /* ==============================================================
     * 4. SSD / NVME
     * ============================================================== */
    // SSD Samsung 980 Pro 1TB, NVMe 500GB, SSD 256GB SATA, NVMe Kingston NV2 1TB, SN770 1TB...
    const reSsd = /(?<![a-z\d])(?:ssd\s|nvme\s|ổ cứng\s)?(samsung|kingston|wd|kioxia|crucial|lexar)?[\s\-]?(980\s?pro|970\s?evo|990\s?pro|nv2|nv3|sn770|sn850x|a400)?[\s\-]?(128|250|256|480|500|512|1000|1|2|4)[\s\-]?(g|gb|t|tb)[\s\-]?(nvme|sata|m\.?2|gen\s?[34])?(?![a-z\d])/gi;
    while ((m = reSsd.exec(line))) {
      const isExplicitStorage = /(?:ssd|nvme|ổ cứng|m\.?2|sata)/i.test(line.slice(Math.max(0, m.index - 15), Math.min(line.length, m.index + m[0].length + 15)));
      if (isExplicitStorage) {
        const brand = m[1] ? m[1].toUpperCase() : '';
        const model = m[2] ? ' ' + m[2].toUpperCase() : '';
        let cap = m[3];
        const unit = m[4].toLowerCase().startsWith('t') ? 'TB' : 'GB';
        if (cap === '1000') { cap = '1'; }
        const type = m[5] ? ' ' + m[5].toUpperCase() : ' NVMe';
        push(m, `SSD ${brand}${model} ${cap}${unit}${type}`.replace(/\s+/g, ' ').trim(), brand || 'SSD', 'SSD');
      }
    }

    /* ==============================================================
     * 5. CPU (INTEL CORE, ULTRA, XEON, AMD RYZEN)
     * ============================================================== */
    // Core Ultra
    const reUltra = /(?<![a-z\d])(?:core\s?)?ultra\s?([3579])[\s\-]?(\d{3,4})(kf|ks|k|f|t|h|u)?(?![a-z\d])/gi;
    while ((m = reUltra.exec(line))) {
      push(m, `Core Ultra ${m[1]} ${m[2]}${(m[3] || '').toUpperCase()}`, 'Intel', 'CPU');
    }

    // Xeon E3, E5, Scalable
    const reXeonE = /(?<![a-z\d])(?:xeon\s?)?e([357])[\s\-]?(\d{4})[\s\-]?(v[1-6])?(?![a-z\d])/gi;
    while ((m = reXeonE.exec(line))) {
      const v = m[3] ? m[3].toLowerCase() : '';
      push(m, `Xeon E${m[1]}-${m[2]}${v ? ' ' + v : ''}`, 'Intel', 'CPU');
    }
    const reXeonScalable = /(?<![a-z\d])(?:xeon\s)?(silver|gold|platinum|bronze)[\s\-]?(\d{4}[a-z]?)(?![a-z\d])/gi;
    while ((m = reXeonScalable.exec(line))) {
      const tier = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
      push(m, `Xeon ${tier} ${m[2].toUpperCase()}`, 'Intel', 'CPU');
    }
    const reXeonBare = /(?<![a-z\d])(26\d{2}|12\d{2})[\s\-]?v([1-5])(?![a-z\d])/gi;
    while ((m = reXeonBare.exec(line))) {
      const prefix = m[1].startsWith('12') ? 'E3' : 'E5';
      push(m, `Xeon ${prefix}-${m[1]} v${m[2]}`, 'Intel', 'CPU');
    }

    // Pentium Gold & Celeron
    const rePentium = /(?<![a-z\d])(?:pentium\s?(?:gold\s?)?|celeron\s?|g)([4567]\d{3})(t|e)?(?![a-z\d])/gi;
    while ((m = rePentium.exec(line))) {
      if (cpuWord || /(?:pentium|celeron)/i.test(line)) {
        push(m, `Pentium G${m[1]}${(m[2] || '').toUpperCase()}`, 'Intel', 'CPU');
      }
    }

    // Core i3 / i5 / i7 / i9
    const reIntel = /(?<![a-z\d])(?:core\s?)?i([3579])[\s\-]?(\d{4,5})(kf|ks|k|f|t)?(?![a-z\d])/gi;
    while ((m = reIntel.exec(line))) {
      if (!validIntel(m[2])) continue;
      push(m, `i${m[1]}-${m[2]}${(m[3] || '').toUpperCase()}`, 'Intel', 'CPU');
    }

    // AMD Ryzen
    const reAmd = /(?<![a-z\d])(?:ryzen\s?|r)([3579])[\s\-]?(\d{4})(x3d|xt|x|gt|g|f|e)?(?![a-z\d])/gi;
    while ((m = reAmd.exec(line))) {
      const n = +m[2];
      if (n >= 2019 && n <= 2030) continue;
      push(m, `Ryzen ${m[1]} ${m[2]}${(m[3] || '').toUpperCase()}`, 'AMD', 'CPU');
    }

    // Threadripper
    const reTR = /(?<![a-z\d])(?:threadripper|tr)[\s\-]?(\d{4})(wx|x)?(?![a-z\d])/gi;
    while ((m = reTR.exec(line))) {
      push(m, `Threadripper ${m[1]}${(m[2] || '').toUpperCase()}`, 'AMD', 'CPU');
    }

    // Athlon
    const reAthlon = /(?<![a-z\d])athlon[\s\-]?(\d{3,4}[a-z]?)(?![a-z\d])/gi;
    while ((m = reAthlon.exec(line))) {
      push(m, `Athlon ${m[1].toUpperCase()}`, 'AMD', 'CPU');
    }

    // Ryzen No Tier
    const reAmdNoTier = /(?<![a-z\d])ryzen\s?(\d{4})(x3d|xt|x|gt|g|f)?(?![a-z\d])/gi;
    while ((m = reAmdNoTier.exec(line))) {
      const key = (m[1] + (m[2] || '')).toUpperCase();
      if (AMD_TABLE[key]) {
        const tier = AMD_TABLE[key];
        push(m, tier === 'Athlon' ? `Athlon ${key}` : `Ryzen ${tier} ${key}`, 'AMD', 'CPU');
      }
    }

    // AMD Bare
    const reAmdBare = /(?<![a-z\d\-.,])(\d{4})(x3d|xt|x|gt|g|f)?(?![a-z\d])/gi;
    while ((m = reAmdBare.exec(line))) {
      const key = (m[1] + (m[2] || '')).toUpperCase();
      if (AMD_TABLE[key] && (m[2] === 'x3d' || m[2] === 'gt' || cpuWord)) {
        const tier = AMD_TABLE[key];
        push(m, tier === 'Athlon' ? `Athlon ${key}` : `Ryzen ${tier} ${key}`, 'AMD', 'CPU');
      }
    }

    // Intel Bare
    const reIntelBare = /(?<![a-z\d\-.,])(1[0-4]\d{3})(kf|ks|k|f)?(?![a-z\d])/gi;
    while ((m = reIntelBare.exec(line))) {
      const tier = INTEL_TIER[m[1][2]];
      if (!tier) continue;
      const hasSuffix = !!m[2];
      const baseOk = /^1[0-4][14567]00$|^1[0-4]900$/.test(m[1]);
      if (hasSuffix || (cpuWord && baseOk)) {
        push(m, `i${tier}-${m[1]}${(m[2] || '').toUpperCase()}`, 'Intel', 'CPU');
      }
    }

    return out.sort((a, b) => a.index - b.index);
  }

  function extractPrices(lineLower, models) {
    let s = lineLower;
    const blank = (a, b) => { s = s.slice(0, a) + ' '.repeat(b - a) + s.slice(b); };
    (models || []).forEach(md => blank(md.index, md.end));
    s = s.replace(/(?<!\d)0\d{2}[\s.\-]?\d{3}[\s.\-]?\d{3,4}(?!\d)/g, x => ' '.repeat(x.length));

    const found = [];
    const take = (re, fn) => {
      const ms = [...s.matchAll(re)];
      for (const m of ms) {
        const v = fn(m);
        if (v) found.push({ value: Math.round(v), index: m.index, raw: m[0].trim() });
      }
      for (const m of ms) blank(m.index, m.index + m[0].length);
    };
    const frac = (d) => !d ? 0 : d.length === 1 ? +d * 100000 : d.length === 2 ? +d * 10000 : +d * 1000;

    // 2.2tr / 2,5 triệu / 5tr2
    take(/(?<!\d)(\d{1,2})[.,](\d{1,3})\s*(?:tr|triệu|trieu|củ|m)(?![a-z\d])/gi,
      m => parseFloat(`${m[1]}.${m[2]}`) * 1e6);
    take(/(?<!\d)(\d{1,2})\s*(?:tr|triệu|trieu|củ)\s*(\d{1,3})?(?![a-z\d])/gi,
      m => +m[1] * 1e6 + frac(m[2]));
    take(/(?<!\d)(\d)m(\d{1,3})(?![a-z\d])/gi, m => +m[1] * 1e6 + frac(m[2]));
    take(/(?<!\d)(\d{1,2})[.,](\d{3})\s*k(?![a-z\d])/gi, m => (+m[1] * 1000 + +m[2]) * 1000);
    take(/(?<!\d)(\d{3,5})\s*k(?![a-z\d])/gi, m => +m[1] * 1000);
    take(/(?<!\d)(\d{1,3}(?:[.,]\d{3}){2,3})\s*(?:đ|vnđ|vnd|₫|d)?(?!\d)/gi,
      m => +m[1].replace(/[.,]/g, ''));
    take(/(?<!\d)(\d{6,8})\s*(?:đ|vnđ|vnd|₫)(?![a-z\d])/gi, m => +m[1]);

    return found.filter(p => p.value >= PRICE_MIN && p.value <= PRICE_MAX).sort((a, b) => a.index - b.index);
  }

  function detectIntent(s) {
    const buy = BUY.test(s);
    const sell = SELL.test(s.replace(new RegExp(BUY.source, 'giu'), ' '));
    if (buy && !sell) return 'buy';
    if (sell && !buy) return 'sell';
    return null;
  }

  function detectCondition(s) {
    if (USED.test(s)) return 'used';
    if (TRAY.test(s)) return 'new-tray';
    if (SEALED.test(s)) return 'new-sealed';
    return 'unknown';
  }

  function detectSold(s) {
    return SOLD.test(s);
  }

  function isComboLine(l) {
    if (COMBO_KW.test(l)) return true;
    const comps = new Set((l.match(/(?:main|ram|vga|gpu|rtx|gtx|cpu|nvme|ssd|psu|nguồn|case)/gi) || []).map(x => x.trim()));
    if (l.includes('+') && comps.size >= 1) return true;
    return comps.size >= 2;
  }

  function looksLikeHardware(text) {
    if (!text) return false;
    const lines = text.toLowerCase().split(/\n+/);
    if (lines.some(l => findModels(l).length > 0)) return true;
    return /(?:cpu|vi xử lý|chip|vga|gpu|cạc|rtx|gtx|radeon|rx\s*\d{3,4}|main|mainboard|bo mạch|ram|ddr[345]|nvme|ssd|ổ cứng|pc gaming|linh kiện|thanh lý máy|dàn máy|case máy)/i.test(text);
  }

  /**
   * Phân tích nội dung bài viết mua bán linh kiện PC
   */
  function analyze(rawText, options = {}) {
    const text = (rawText || '').normalize('NFC').replace(/\u00a0/g, ' ');
    const lines = text.split(/\r?\n+/).map(l => l.trim()).filter(Boolean);
    const lows = lines.map(l => l.toLowerCase());
    const whole = lows.join('\n');
    const postCond = detectCondition(whole);
    const postIntent = detectIntent(whole);
    const postSold = detectSold(whole);
    const inboxPost = INBOX.test(whole);

    const rows = lows.map((l, i) => {
      const models = findModels(l);
      return { i, l, models, prices: extractPrices(l, models) };
    });
    const distinctModels = new Set(rows.flatMap(r => r.models.map(m => m.name)));
    const listings = [];

    for (const row of rows) {
      if (!row.models.length) continue;
      const lineIntent = detectIntent(row.l);
      const lineCond = detectCondition(row.l);
      const lineSold = detectSold(row.l);
      const combo = isComboLine(row.l);

      row.models.forEach((mod, k) => {
        const next = row.models[k + 1];
        let seg = row.prices.filter(p => p.index >= mod.end && (!next || p.index < next.index));
        let source = 'line';

        if (!seg.length && row.models.length === 1) {
          for (let j = row.i + 1; j <= Math.min(row.i + 2, rows.length - 1); j++) {
            if (rows[j].models.length) break;
            if (rows[j].prices.length) { seg = [rows[j].prices[0]]; source = 'nextline'; break; }
          }
        }
        if (!seg.length && distinctModels.size === 1) {
          const all = [...new Set(rows.filter(r => !r.models.length || r === row).flatMap(r => r.prices.map(p => p.value)))];
          if (all.length === 1) { seg = [{ value: all[0] }]; source = 'post'; }
        }

        const values = [...new Set(seg.map(p => p.value))];
        const price = values.length ? values[0] : null;
        const multi = values.length > 1;
        const intent = lineIntent || postIntent;

        let priceType;
        if (combo) priceType = 'combo';
        else if (intent === 'buy') priceType = 'buy';
        else if (price == null) priceType = (INBOX.test(row.l) || inboxPost) ? 'inbox' : 'unknown';
        else if (intent === 'sell') priceType = 'sell';
        else priceType = source === 'line' ? 'sell' : 'unknown';

        const isSold = lineSold || (postSold && distinctModels.size <= 2);

        let needsReview = false, reviewReason = '';
        let isOutlier = false, outlierReason = '';

        if (['sell', 'unknown', 'inbox'].includes(priceType)) {
          if (price == null) {
            needsReview = true;
            reviewReason = 'Không thấy giá trong bài';
          } else if (multi) {
            needsReview = true;
            reviewReason = 'Có nhiều mức giá cạnh nhau';
          } else if (priceType === 'unknown') {
            needsReview = true;
            reviewReason = 'Chưa rõ là bán hay mua';
          } else if (source === 'post') {
            needsReview = true;
            reviewReason = 'Giá lấy từ chỗ khác trong bài';
          }
        }

        // Lọc giá ảo (outlier) dựa trên bảng trung vị tham chiếu
        if (price != null && options.medianMap && options.medianMap[mod.name]) {
          const med = options.medianMap[mod.name];
          if (med >= 400000) {
            if (price >= med * 2.3) {
              isOutlier = true;
              outlierReason = `Giá cao bất thường (${fmtShort(price)} vs trung vị ${fmtShort(med)})`;
              needsReview = true;
              reviewReason = reviewReason || outlierReason;
            } else if (price <= med * 0.38) {
              isOutlier = true;
              outlierReason = `Giá thấp bất thường (${fmtShort(price)} vs trung vị ${fmtShort(med)})`;
              needsReview = true;
              reviewReason = reviewReason || outlierReason;
            }
          }
        }

        listings.push({
          model: mod.name,
          brand: mod.brand,
          category: mod.category || 'CPU',
          price,
          priceType,
          condition: lineCond !== 'unknown' ? lineCond : postCond,
          isSold,
          isOutlier,
          outlierReason,
          needsReview,
          reviewReason,
          altPrices: values.slice(1),
          line: lines[row.i].slice(0, 200)
        });
      });
    }

    const seen = new Set();
    const uniq = listings.filter(l => {
      const k = [l.model, l.price, l.condition, l.priceType, l.isSold].join('|');
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    return { listings: uniq, hasHardware: uniq.length > 0, hasCpu: uniq.some(l => l.category === 'CPU') };
  }

  function summarize(values) {
    const v = values.filter(x => typeof x === 'number').sort((a, b) => a - b);
    if (!v.length) return null;
    const n = v.length;
    const mean = v.reduce((a, b) => a + b, 0) / n;
    const median = n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
    const count = new Map();
    v.forEach(x => count.set(x, (count.get(x) || 0) + 1));
    let mode = v[0], best = 0;
    for (const [x, c] of count) if (c > best) { best = c; mode = x; }
    return { n, min: v[0], max: v[n - 1], mean, median, mode };
  }

  function calculateTrend(currentMedian, prevMedian) {
    if (!currentMedian || !prevMedian) {
      return { diff: 0, percent: 0, text: 'Mới', direction: 'flat' };
    }
    const diff = currentMedian - prevMedian;
    const percent = Math.round((diff / prevMedian) * 1000) / 10;
    if (Math.abs(diff) < 20000) {
      return { diff: 0, percent: 0, text: '→ Không đổi', direction: 'flat' };
    }
    if (diff < 0) {
      return { diff, percent, text: `↓ ${fmtShort(Math.abs(diff))} (${percent}%)`, direction: 'down' };
    }
    return { diff, percent, text: `↑ +${fmtShort(diff)} (+${percent}%)`, direction: 'up' };
  }

  const fmtShort = (n) => {
    if (n == null) return '—';
    const tr = n / 1e6;
    return (Math.round(tr * 100) / 100).toString().replace('.', ',') + 'tr';
  };

  const fmtFull = (n) => n == null ? '—' : n.toLocaleString('vi-VN') + 'đ';

  function parsePrice(str) {
    const s = String(str || '').toLowerCase().trim();
    if (/^\d{6,8}$/.test(s)) return +s;
    const p = extractPrices(s, []);
    return p.length ? p[0].value : null;
  }

  function getSnippetFingerprint(preview) {
    if (!preview) return '';
    let text = String(preview)
      .replace(/^.*?trong\s+[^:]+:\s*/i, '')
      .replace(/^(.*?)\s*đã đăng trong\s+[^:]+:\s*/i, '')
      .replace(/(?:\.{2,4}|…|\s)*(?:xem thêm|see more|xem tiếp|hiển thị thêm).*$/i, '');
    text = text.toLowerCase()
      .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'–—]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length >= 18 ? text.slice(0, 120) : '';
  }

  function getContentFingerprint(text) {
    if (!text) return '';
    let clean = String(text).toLowerCase()
      .replace(/(?:\.{2,4}|…|\s)*(?:xem thêm|see more|xem tiếp|hiển thị thêm)/gi, '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'–—]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return clean.length >= 25 ? clean.slice(0, 160) : '';
  }

  return {
    analyze,
    summarize,
    calculateTrend,
    findModels,
    extractPrices,
    looksLikeHardware,
    looksLikeCpu: looksLikeHardware,
    getSnippetFingerprint,
    getContentFingerprint,
    parsePrice,
    detectSold,
    fmtShort,
    fmtFull,
    AMD_TABLE
  };
})();

// Alias tương thích ngược cho CPUAnalyzer
const CPUAnalyzer = HardwareAnalyzer;

if (typeof self !== 'undefined') {
  self.HardwareAnalyzer = HardwareAnalyzer;
  self.CPUAnalyzer = HardwareAnalyzer;
}
if (typeof window !== 'undefined') {
  window.HardwareAnalyzer = HardwareAnalyzer;
  window.CPUAnalyzer = HardwareAnalyzer;
}
if (typeof globalThis !== 'undefined') {
  globalThis.HardwareAnalyzer = HardwareAnalyzer;
  globalThis.CPUAnalyzer = HardwareAnalyzer;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = HardwareAnalyzer;
}
