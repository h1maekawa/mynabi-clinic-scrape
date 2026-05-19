const LIST_PATH_RE = /^\/article_list(\/|$)/i;
const ARTICLE_PATH_RE = /^\/article\/[a-z0-9_-]+\/?$/i;
const ARTICLE_TITLE_SELECTOR = "a.m-article_header_title, .m-article_header_title a";
const DAY_LABELS = ["月", "火", "水", "木", "金", "土", "日", "祝"];

const PREFECTURES = [
    "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県",
    "埼玉県", "千葉県", "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県",
    "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
    "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県",
    "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県"
];

const state = { running: false, rows: [] };

const ui = {
    startUrl: document.getElementById("startUrl"),
    maxPages: document.getElementById("maxPages"),
    maxClinics: document.getElementById("maxClinics"),
    delay: document.getElementById("delay"),
    startBtn: document.getElementById("startBtn"),
    jsonBtn: document.getElementById("jsonBtn"),
    csvBtn: document.getElementById("csvBtn"),
    status: document.getElementById("status"),
    log: document.getElementById("log"),
};

function setStatus(text) { ui.status.textContent = text; }

function log(message) {
    const now = new Date();
    const stamp = now.toLocaleTimeString("ja-JP", { hour12: false });
    ui.log.textContent += `[${stamp}] ${message}\n`;
    ui.log.scrollTop = ui.log.scrollHeight;
}

function sleep(sec) {
    if (!sec || sec <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, sec * 1000));
}

function normalizeUrl(url) {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search}`;
}

function cleanText(value) {
    return (value || "")
        .replace(/\s+/g, " ")
        .replace(/^[\s\-]+|[\s\-]+$/g, "")
        .trim();
}

function errText(err) {
    if (!err) return "Unknown error";
    if (typeof err === "string") return err;
    if (err.message) return err.message;
    return String(err);
}

function pushUnique(arr, set, value) {
    if (set.has(value)) return;
    set.add(value);
    arr.push(value);
}

async function fetchHtml(url) {
    const res = await fetch(url, { method: "GET", credentials: "omit", cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
}

function toSameHostUrl(baseUrl, href) {
    let abs;
    try { abs = new URL(href, baseUrl); } catch { return null; }
    const base = new URL(baseUrl);
    if (abs.host !== base.host) return null;
    return abs;
}

function extractArticleAndListLinks(baseUrl, html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const articleLinks = [], listLinks = [];
    const articleSeen = new Set(), listSeen = new Set();

    doc.querySelectorAll(".m-article-list_item").forEach((item) => {
        const titleAnchor = item.querySelector(ARTICLE_TITLE_SELECTOR) || item.querySelector("a[href]");
        const href = titleAnchor?.getAttribute("href")?.trim();
        if (!href) return;
        const abs = toSameHostUrl(baseUrl, href);
        if (!abs || !ARTICLE_PATH_RE.test(abs.pathname)) return;
        pushUnique(articleLinks, articleSeen, normalizeUrl(abs.href));
    });

    if (articleLinks.length === 0) {
        doc.querySelectorAll("a[href]").forEach((a) => {
            const href = a.getAttribute("href")?.trim();
            if (!href) return;
            const abs = toSameHostUrl(baseUrl, href);
            if (!abs || !ARTICLE_PATH_RE.test(abs.pathname)) return;
            pushUnique(articleLinks, articleSeen, normalizeUrl(abs.href));
        });
    }

    doc.querySelectorAll("a[href]").forEach((a) => {
        const href = a.getAttribute("href")?.trim();
        if (!href) return;
        const abs = toSameHostUrl(baseUrl, href);
        if (!abs || !LIST_PATH_RE.test(abs.pathname)) return;
        pushUnique(listLinks, listSeen, normalizeUrl(abs.href));
    });

    return { articleLinks, listLinks };
}

function valueByThLabel(root, label) {
    const rows = Array.from(root.querySelectorAll("tr"));
    for (const tr of rows) {
        const th = tr.querySelector("th");
        const td = tr.querySelector("td");
        if (!th || !td) continue;
        if (cleanText(th.textContent).includes(label)) return cleanText(td.textContent);
    }
    return "";
}

function normalizeScheduleMark(text) {
    const t = cleanText(text);
    if (!t) return "";
    if (/[●○◯〇]/.test(t)) return "●";
    if (/[✕✖×]/.test(t)) return "×";
    if (/[休]/.test(t)) return "休";
    if (/[\-ー－―–—]/.test(t)) return "-";
    return t;
}

function inferMark(cell) {
    const attrs = [
        cell.getAttribute("aria-label") || "",
        cell.getAttribute("title") || "",
        cell.getAttribute("data-status") || "",
        cell.getAttribute("class") || "",
        cell.innerHTML || "",
    ].join(" ");
    if (/(circle|maru|open|available|on)/i.test(attrs)) return "●";
    if (/(cross|close|ng|xmark)/i.test(attrs)) return "×";
    if (/(dash|bar|hyphen|off|holiday|rest)/i.test(attrs)) return "-";
    return "";
}

function parseConsultationHoursFromTable(table) {
    const rows = Array.from(table.querySelectorAll("tr"));
    if (rows.length < 2) return "";
    const headCells = Array.from(rows[0].querySelectorAll("th,td"));
    if (headCells.length < 2) return "";
    const headerText = cleanText(rows[0].textContent);
    const hasHoursHeader = headerText.includes("診療時間") || headCells.some((c) => cleanText(c.textContent) === "診療時間");
    if (!hasHoursHeader) return "";
    let dayCols = headCells.slice(1).map((c) => cleanText(c.textContent));
    if (!dayCols.length || dayCols.every((d) => !d)) dayCols = DAY_LABELS.slice(0, headCells.length - 1);
    const lines = [];
    for (const row of rows.slice(1)) {
        const cells = Array.from(row.querySelectorAll("th,td"));
        if (cells.length < 2) continue;
        const timeText = cleanText(cells[0].textContent);
        if (!timeText || timeText.includes("診療時間")) continue;
        const parts = [];
        for (let i = 1; i < cells.length; i++) {
            const day = dayCols[i - 1] || DAY_LABELS[i - 1] || `col${i}`;
            let mark = normalizeScheduleMark(cells[i].textContent);
            if (!mark) mark = inferMark(cells[i]);
            if (!mark) mark = "-";
            parts.push(`${day}:${mark}`);
        }
        lines.push(`${timeText} ${parts.join(" ")}`);
    }
    return lines.join(" | ");
}

function extractConsultationHours(block) {
    const tables = Array.from(block.querySelectorAll("table"));
    for (const table of tables) {
        const parsed = parseConsultationHoursFromTable(table);
        if (parsed) return parsed;
    }
    return valueByThLabel(block, "診療時間");
}

function extractFacilityName(block) {
    const selectors = [
        ".post-clinic-block_title", ".post-clinic-block_name",
        ".post-clinic-name", ".m-clinic-card_title", "h2", "h3", "h4",
    ];
    for (const sel of selectors) {
        const text = cleanText(block.querySelector(sel)?.textContent || "");
        if (text) return text;
    }
    return cleanText(block.querySelector("strong")?.textContent || "");
}

function extractHomepage(block, articleUrl) {
    const anchors = Array.from(block.querySelectorAll("a[href]"));
    for (const a of anchors) {
        const txt = cleanText(a.textContent);
        const href = a.getAttribute("href")?.trim();
        if (!href) continue;
        try {
            const abs = new URL(href, articleUrl).href;
            if (/(公式|ホームページ|HP)/i.test(txt)) return abs;
        } catch { }
    }
    for (const a of anchors) {
        const href = a.getAttribute("href")?.trim();
        if (!href) continue;
        try {
            const abs = new URL(href, articleUrl);
            if (/^https?:/i.test(abs.protocol)) return abs.href;
        } catch { }
    }
    return "";
}

function extractPhone(block) {
    const labelPhone = valueByThLabel(block, "電話番号");
    if (labelPhone) return labelPhone;
    const m = cleanText(block.textContent).match(/0\d{1,4}-\d{1,4}-\d{3,4}/);
    return m ? m[0] : "";
}

function extractPrefecture(doc, title) {
    for (const pref of PREFECTURES) {
        if (title.includes(pref)) return pref;
    }
    for (const a of Array.from(doc.querySelectorAll("a"))) {
        const txt = cleanText(a.textContent);
        if (PREFECTURES.includes(txt)) return txt;
    }
    const bodyText = doc.body?.textContent || "";
    for (const pref of PREFECTURES) {
        if (bodyText.includes(`「${pref}・`)) return pref;
    }
    return "";
}

function extractArea(title) {
    const m = title.match(/(?:】|\]|\[|【|\s|^)([^】\]\[【\s]+?[市区郡町村])/);
    if (m && m[1].length <= 15) {
        let area = m[1].replace(/^[^\w\u3040-\u30FF\u4E00-\u9FFF]+/, "");
        for (const pref of PREFECTURES) {
            if (area.startsWith(pref) && area !== pref) area = area.substring(pref.length);
        }
        return area;
    }
    return "";
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ★ 追加: heading__title（記事タイトル）取得
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function extractHeadingTitle(doc) {
    const el =
        doc.querySelector("h1.heading__title") ||
        doc.querySelector(".heading__title") ||
        doc.querySelector("[class*='heading__title']") ||
        doc.querySelector("h1");
    return cleanText(el?.textContent || "");
}

function extractClinicsFromArticleHtml(html, articleUrl) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const articleTitle = cleanText(
        doc.querySelector(".m-article_header .m-article_header_title, .m-article_header_title, h1")?.textContent || ""
    );

    // ★ 記事タイトルを取得（heading__title → h1 の優先順位）
    const headingTitle = extractHeadingTitle(doc);

    const blocks = Array.from(doc.querySelectorAll(".post-clinic-block"));
    const rows = [];

    blocks.forEach((block) => {
        const hours = extractConsultationHours(block);

        // 診療時間の各枠を分割して解析
        const timeParts = hours ? hours.split("|").map(s => s.trim()) : [];

        const parseTime = (part, pos) => {
            if (!part) return "";
            const m = part.match(/(\d{1,2}:\d{2})[〜～\-~](\d{1,2}:\d{2})/);
            return m ? m[pos] : "";
        };

        // 休診日: tableの「休」マークから収集 + テキスト内の休診日表記
        let closedDays = valueByThLabel(block, "休診日");
        if (!closedDays) {
            const closedSet = new Set();
            const dayMatches = hours.matchAll(/([月火水木金土日祝]):休/g);
            for (const dm of dayMatches) closedSet.add(dm[1]);
            closedDays = [...closedSet].join("、");
        }
        if (!closedDays) {
            const m = cleanText(block.textContent).match(/休診日[：:]\s*([^\n。]{1,50})/);
            if (m) closedDays = m[1].trim();
        }

        rows.push({
            記事タイトル: headingTitle,          // ★ 一番左に追加
            診療科目: extractPrefecture(doc, articleTitle) ? extractArea(articleTitle) : "",
            電話番号: extractPhone(block),
            医院名: extractFacilityName(block),
            午前始: parseTime(timeParts[0], 1),
            午前終: parseTime(timeParts[0], 2),
            午後始: parseTime(timeParts[1], 1),
            午後終: parseTime(timeParts[1], 2),
            休診日: closedDays,
        });
    });

    return rows;
}

async function discoverArticlePages(startUrl, maxPages, delaySec) {
    const queue = [normalizeUrl(startUrl)];
    const queuedSet = new Set(queue);
    const visitedListPages = new Set();
    const articlePages = [];
    const articleSeen = new Set();

    while (queue.length && visitedListPages.size < maxPages) {
        const url = queue.shift();
        if (!url || visitedListPages.has(url)) continue;
        visitedListPages.add(url);
        setStatus(`一覧ページ巡回: ${visitedListPages.size}/${maxPages}`);
        log(`一覧取得: ${url}`);
        let html;
        try {
            html = await fetchHtml(url);
        } catch (err) {
            log(`WARN 一覧取得失敗: ${url} (${errText(err)})`);
            continue;
        }
        const { articleLinks, listLinks } = extractArticleAndListLinks(url, html);
        articleLinks.forEach((u) => pushUnique(articlePages, articleSeen, u));
        listLinks.forEach((u) => {
            if (visitedListPages.has(u) || queuedSet.has(u)) return;
            queue.push(u);
            queuedSet.add(u);
        });
        await sleep(delaySec);
    }
    return articlePages;
}

function encodeCsvField(value) {
    const text = value == null ? "" : String(value);
    if (text.includes('"') || text.includes(",") || text.includes("\n")) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

function toCsv(rows) {
    // ★ 一番左に「記事タイトル」を追加、以降は現在のCSVと同じ列順
    const headers = [
        "記事タイトル",   // ★ 追加
        "診療科目",
        "電話番号",
        "医院名",
        "午前始",
        "午前終",
        "午後始",
        "午後終",
        "休診日",
    ];
    const lines = [headers.join(",")];
    rows.forEach((row) => {
        lines.push(headers.map((h) => encodeCsvField(row[h] ?? "")).join(","));
    });
    return `\uFEFF${lines.join("\n")}`;
}

function downloadText(filename, text, mimeType) {
    const blob = new Blob([text], { type: mimeType });
    const objectUrl = URL.createObjectURL(blob);
    chrome.downloads.download(
        { url: objectUrl, filename, saveAs: true },
        () => setTimeout(() => URL.revokeObjectURL(objectUrl), 1000),
    );
}

async function runScrape() {
    if (state.running) return;
    const startUrl = ui.startUrl.value.trim();
    const maxPages = Number(ui.maxPages.value) || 80;
    const maxClinics = Number(ui.maxClinics.value) || 0;
    const delaySec = Number(ui.delay.value) || 0;
    try { new URL(startUrl); } catch { alert("開始URLが不正です。"); return; }

    state.running = true;
    state.rows = [];
    ui.startBtn.disabled = true;
    ui.jsonBtn.disabled = true;
    ui.csvBtn.disabled = true;
    ui.log.textContent = "";
    log("スクレイピング開始");

    try {
        const articleUrls = await discoverArticlePages(startUrl, maxPages, delaySec);
        log(`記事ページ発見: ${articleUrls.length}件`);
        const rows = [];
        for (let i = 0; i < articleUrls.length; i++) {
            const articleUrl = articleUrls[i];
            setStatus(`記事解析中: ${i + 1}/${articleUrls.length}`);
            log(`記事取得: ${articleUrl}`);
            try {
                const html = await fetchHtml(articleUrl);
                const extracted = extractClinicsFromArticleHtml(html, articleUrl);
                extracted.forEach((r) => rows.push(r));
                log(`post-clinic-block抽出: ${extracted.length}件`);
            } catch (err) {
                log(`WARN 記事取得失敗: ${articleUrl} (${errText(err)})`);
            }
            if (maxClinics > 0 && rows.length >= maxClinics) break;
            await sleep(delaySec);
        }
        state.rows = maxClinics > 0 ? rows.slice(0, maxClinics) : rows;
        setStatus(`完了: ${state.rows.length}件`);
        log(`完了: ${state.rows.length}件`);
        ui.jsonBtn.disabled = state.rows.length === 0;
        ui.csvBtn.disabled = state.rows.length === 0;
    } catch (err) {
        setStatus("エラーで停止しました");
        log(`ERROR: ${errText(err)}`);
    } finally {
        state.running = false;
        ui.startBtn.disabled = false;
    }
}

ui.startBtn.addEventListener("click", runScrape);
ui.jsonBtn.addEventListener("click", () => {
    if (!state.rows.length) return;
    downloadText(
        `mynavi_article_clinics_${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(state.rows, null, 2),
        "application/json;charset=utf-8",
    );
});
ui.csvBtn.addEventListener("click", () => {
    if (!state.rows.length) return;
    downloadText(
        `mynavi_article_clinics_${new Date().toISOString().slice(0, 10)}.csv`,
        toCsv(state.rows),
        "text/csv;charset=utf-8",
    );
});