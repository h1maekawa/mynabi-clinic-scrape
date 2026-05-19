/**
 * df-scraper.js
 * Doctors File (https://doctorsfile.jp) 専用 Chrome 拡張機能スクレイパー
 *
 * ■ 対象: 検索一覧ページ内で class="result-link__article" を持つ
 *          (= 取材記事あり) クリニックのみを収集・解析。
 *
 * ■ 取得項目:
 *   医院名 / 医師名 / 診療科目 / 住所 / 都道府県 / エリア
 *   最寄駅 / 電話番号 / 診療時間 / 休診日 / 特徴 / 紹介文
 *   記事URL / 取材記事URL / 緯度 / 経度 / 取得日時
 *
 * ■ アーキテクチャ: マイナビスクレイパー (extension/scraper.js) と同設計。
 */

"use strict";

/* ═══════════════════════════════════════════════════
   § 1  定数
   ═══════════════════════════════════════════════════ */

const DF_HOST       = "https://doctorsfile.jp";
const DF_SEARCH_RE  = /^\/search\//i;

const PREFECTURES = [
    "北海道","青森県","岩手県","宮城県","秋田県","山形県","福島県","茨城県","栃木県","群馬県",
    "埼玉県","千葉県","東京都","神奈川県","新潟県","富山県","石川県","福井県","山梨県","長野県",
    "岐阜県","静岡県","愛知県","三重県","滋賀県","京都府","大阪府","兵庫県","奈良県","和歌山県",
    "鳥取県","島根県","岡山県","広島県","山口県","徳島県","香川県","愛媛県","高知県","福岡県",
    "佐賀県","長崎県","熊本県","大分県","宮崎県","鹿児島県","沖縄県",
];

/* ═══════════════════════════════════════════════════
   § 2  状態 / UI 参照
   ═══════════════════════════════════════════════════ */

const state = { running: false, rows: [] };

const ui = {
    startUrl:   document.getElementById("startUrl"),
    maxPages:   document.getElementById("maxPages"),
    maxClinics: document.getElementById("maxClinics"),
    delay:      document.getElementById("delay"),
    startBtn:   document.getElementById("startBtn"),
    jsonBtn:    document.getElementById("jsonBtn"),
    csvBtn:     document.getElementById("csvBtn"),
    status:     document.getElementById("status"),
    log:        document.getElementById("log"),
};

/* ═══════════════════════════════════════════════════
   § 3  共通ユーティリティ
   ═══════════════════════════════════════════════════ */

function setStatus(text) { ui.status.textContent = text; }

function log(message) {
    const stamp = new Date().toLocaleTimeString("ja-JP", { hour12: false });
    ui.log.textContent += `[${stamp}] ${message}\n`;
    ui.log.scrollTop = ui.log.scrollHeight;
}

function sleep(sec) {
    if (!sec || sec <= 0) return Promise.resolve();
    return new Promise((r) => setTimeout(r, sec * 1000));
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
    if (!value || set.has(value)) return;
    set.add(value);
    arr.push(value);
}

function normalizeUrl(url) {
    try {
        const u = new URL(url);
        return `${u.origin}${u.pathname}`;
    } catch { return url; }
}

async function fetchHtml(url) {
    const res = await fetch(url, { method: "GET", credentials: "omit", cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.text();
}

/* ═══════════════════════════════════════════════════
   § 4  検索一覧ページ解析
   ═══════════════════════════════════════════════════ */

/**
 * 検索一覧ページから「取材記事あり」クリニックURL と次ページURLを抽出。
 * 判定基準: a.result-link__article が存在するカード、または href に /df/ を含むリンク。
 */
function extractLinksFromSearchPage(baseUrl, html) {
    const doc          = new DOMParser().parseFromString(html, "text/html");
    const clinicUrls   = [];
    const clinicSeen   = new Set();
    const nextPageUrls = [];
    const nextPageSeen = new Set();

    // ── 1次: result-link__article クラスから /h/{id}/ を逆引き ──────
    doc.querySelectorAll("a.result-link__article").forEach((a) => {
        const m = (a.getAttribute("href") || "").trim().match(/^(\/h\/\d+)\//);
        if (m) pushUnique(clinicUrls, clinicSeen, `${DF_HOST}${m[1]}/`);
    });

    // ── 2次 (フォールバック): /df/ リンクから逆引き ─────────────────
    if (clinicUrls.length === 0) {
        doc.querySelectorAll("a[href*='/df/']").forEach((a) => {
            const m = (a.getAttribute("href") || "").trim().match(/^(\/h\/\d+)\//);
            if (m) pushUnique(clinicUrls, clinicSeen, `${DF_HOST}${m[1]}/`);
        });
    }

    // ── ページネーション (?page=N) ────────────────────────────────────
    doc.querySelectorAll("a[href]").forEach((a) => {
        const href = (a.getAttribute("href") || "").trim();
        try {
            const abs = new URL(href, baseUrl);
            if (abs.host !== new URL(DF_HOST).host) return;
            if (!DF_SEARCH_RE.test(abs.pathname)) return;
            if (!abs.searchParams.has("page")) return;
            pushUnique(nextPageUrls, nextPageSeen, abs.href);
        } catch { /* ignore */ }
    });

    return { clinicUrls, nextPageUrls };
}

/* ═══════════════════════════════════════════════════
   § 5  クリニック基本ページ解析ヘルパー群
   ═══════════════════════════════════════════════════ */

function dfExtractAddress(doc) {
    const selectors = [
        ".basic-info__address", ".p-clinic-info__address",
        "[itemprop='streetAddress']", ".clinic-address", ".address",
    ];
    for (const sel of selectors) {
        const text = cleanText(doc.querySelector(sel)?.textContent ?? "");
        if (text) return text;
    }
    // フォールバック: li 要素内の都道府県パターン
    const prefRe = new RegExp(`(${PREFECTURES.join("|")})`);
    for (const li of doc.querySelectorAll("li, dd")) {
        const text = cleanText(li.textContent);
        if (prefRe.test(text) && text.length > 6 && text.length < 120) return text;
    }
    return "";
}

function dfExtractPhone(doc) {
    const selectors = [
        ".basic-info__tel", ".clinic-tel",
        "[itemprop='telephone']", ".tel",
    ];
    for (const sel of selectors) {
        const text = cleanText(doc.querySelector(sel)?.textContent ?? "");
        if (/^0[\d\-]+$/.test(text.replace(/\s/g, ""))) return text;
    }
    const m = cleanText(doc.body?.textContent ?? "").match(/0\d{1,4}-\d{1,4}-\d{3,4}/);
    return m ? m[0] : "";
}

function dfExtractSpecialties(doc) {
    const selectors = [
        ".basic-info__subject", ".clinic-subject",
        ".p-clinic-info__subject", "[itemprop='medicalSpecialty']",
        ".subject-tag", ".tag-subject",
    ];
    for (const sel of selectors) {
        const els = doc.querySelectorAll(sel);
        if (els.length > 0) {
            return Array.from(els).map(el => cleanText(el.textContent)).filter(Boolean).join("、");
        }
    }
    return "";
}

function dfExtractStations(doc) {
    const selectors = [
        ".basic-info__station", ".access-station",
        "[itemprop='publicTransportAccess']", ".station",
    ];
    for (const sel of selectors) {
        const els = doc.querySelectorAll(sel);
        if (els.length > 0) {
            return Array.from(els).map(el => cleanText(el.textContent)).filter(Boolean).join(" / ");
        }
    }
    // フォールバック: *駅 パターン
    const matched = (cleanText(doc.body?.textContent ?? "").match(/[^\s　、/]+駅/g) ?? []);
    return [...new Set(matched)].slice(0, 6).join(" / ");
}

function dfExtractFeatures(doc) {
    const selectors = [
        ".feature-item", ".basic-info__feature",
        ".tag-feature", ".merit-tag",
    ];
    for (const sel of selectors) {
        const els = doc.querySelectorAll(sel);
        if (els.length > 0) {
            return Array.from(els).map(el => cleanText(el.textContent)).filter(Boolean).join("、");
        }
    }
    return "";
}

function dfExtractDescription(doc) {
    const selectors = [
        ".clinic-description", ".basic-info__description",
        ".lead-text", ".summary", ".intro",
    ];
    for (const sel of selectors) {
        const text = cleanText(doc.querySelector(sel)?.textContent ?? "");
        if (text.length > 30) return text;
    }
    // フォールバック: 最長の <p>
    return Array.from(doc.querySelectorAll("p"))
        .map(p => cleanText(p.textContent))
        .filter(t => t.length > 50 && !t.includes("©") && !t.includes("プライバシー"))
        .sort((a, b) => b.length - a.length)[0] ?? "";
}

function dfExtractInterviewUrl(doc, baseUrl) {
    const a = doc.querySelector("a[href*='/df/']");
    if (!a) return "";
    try { return new URL((a.getAttribute("href") || "").trim(), baseUrl).href; }
    catch { return ""; }
}

function dfExtractDoctorName(doc) {
    for (const link of doc.querySelectorAll("a[href*='/df/']")) {
        const text = cleanText(link.textContent);
        const m = text.match(/([^\n\r]+(?:先生|院長|理事長|副院長|医師))/);
        if (m) return cleanText(m[1]);
        // 親要素を確認
        const parent = link.closest("li, div, article") ?? link.parentElement;
        if (parent) {
            const m2 = cleanText(parent.textContent)
                .match(/([^\n\r\s]{2,15}(?:先生|院長|理事長|副院長))/);
            if (m2) return cleanText(m2[1]);
        }
    }
    return "";
}

function dfParseTimeTable(table) {
    return Array.from(table.querySelectorAll("tr"))
        .map(row =>
            Array.from(row.querySelectorAll("th, td"))
                .map(c => cleanText(c.textContent))
                .filter(Boolean)
                .join(": ")
        )
        .filter(Boolean)
        .join(" | ");
}

function dfExtractConsultationHours(doc) {
    for (const sel of ["#timetable table", ".timetable table", ".schedule table"]) {
        const table = doc.querySelector(sel);
        if (table) return dfParseTimeTable(table);
    }
    for (const table of doc.querySelectorAll("table")) {
        const text = cleanText(table.textContent);
        if (text.includes("診療時間") || (text.includes("月") && text.includes("火"))) {
            return dfParseTimeTable(table);
        }
    }
    return "";
}

function dfExtractClosedDays(doc) {
    for (const sel of [".closed-days", ".holiday", ".regular-holiday"]) {
        const text = cleanText(doc.querySelector(sel)?.textContent ?? "");
        if (text) return text;
    }
    for (const tr of doc.querySelectorAll("tr")) {
        const th = tr.querySelector("th");
        const td = tr.querySelector("td");
        if (th && td && cleanText(th.textContent).includes("休診日")) {
            return cleanText(td.textContent);
        }
    }
    return "";
}

function dfExtractArea(doc) {
    const prefRe    = new RegExp(`^(${PREFECTURES.join("|")})$`);
    const areaRe    = /[市区郡町村]$/;
    let prefecture  = "";
    let area        = "";

    for (const a of doc.querySelectorAll(".breadcrumb a, ol a, nav a")) {
        const text = cleanText(a.textContent);
        if (prefRe.test(text))                              { prefecture = text; continue; }
        if (areaRe.test(text) && text.length <= 10)         { area = text; }
    }
    if (!prefecture) {
        for (const pref of PREFECTURES) {
            if ((doc.title || "").includes(pref)) { prefecture = pref; break; }
        }
    }
    return { prefecture, area };
}

function dfExtractLatLng(doc) {
    for (const script of doc.querySelectorAll("script[type='application/ld+json']")) {
        try {
            const data = JSON.parse(script.textContent ?? "");
            const geo  = data?.geo ?? data?.[0]?.geo ?? null;
            if (geo?.latitude && geo?.longitude) {
                return { lat: String(geo.latitude), lng: String(geo.longitude) };
            }
        } catch { /* ignore */ }
    }
    const el = doc.querySelector("[data-lat][data-lng], [data-latitude][data-longitude]");
    if (el) {
        return {
            lat: el.getAttribute("data-lat") ?? el.getAttribute("data-latitude") ?? "",
            lng: el.getAttribute("data-lng") ?? el.getAttribute("data-longitude") ?? "",
        };
    }
    return { lat: "", lng: "" };
}

/* ═══════════════════════════════════════════════════
   § 6  クリニック基本ページ → レコード変換
   ═══════════════════════════════════════════════════ */

function extractClinicFromHtml(html, clinicBaseUrl) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const { prefecture, area } = dfExtractArea(doc);
    const { lat, lng }         = dfExtractLatLng(doc);

    return {
        医院名:       cleanText(doc.querySelector("h1")?.textContent ?? ""),
        医師名:       dfExtractDoctorName(doc),
        診療科目:     dfExtractSpecialties(doc),
        住所:         dfExtractAddress(doc),
        都道府県:     prefecture,
        エリア:       area,
        最寄駅:       dfExtractStations(doc),
        電話番号:     dfExtractPhone(doc),
        診療時間:     dfExtractConsultationHours(doc),
        休診日:       dfExtractClosedDays(doc),
        特徴:         dfExtractFeatures(doc),
        紹介文:       dfExtractDescription(doc),
        クリニックURL: clinicBaseUrl,
        取材記事URL:  dfExtractInterviewUrl(doc, clinicBaseUrl),
        緯度:         lat,
        経度:         lng,
        取得日時:     new Date().toISOString(),
    };
}

/* ═══════════════════════════════════════════════════
   § 7  クロール: 一覧ページ → クリニックURL収集
   ═══════════════════════════════════════════════════ */

async function discoverClinicPages(startUrl, maxPages, delaySec) {
    const queue         = [normalizeUrl(startUrl)];
    const queuedSet     = new Set(queue);
    const visitedPages  = new Set();
    const clinicUrls    = [];
    const clinicSeen    = new Set();

    while (queue.length && visitedPages.size < maxPages) {
        const url = queue.shift();
        if (!url || visitedPages.has(url)) continue;
        visitedPages.add(url);

        setStatus(`一覧巡回: ${visitedPages.size}/${maxPages}`);
        log(`一覧取得: ${url}`);

        let html;
        try { html = await fetchHtml(url); }
        catch (err) {
            log(`WARN 一覧取得失敗: ${url} (${errText(err)})`);
            await sleep(delaySec);
            continue;
        }

        const { clinicUrls: found, nextPageUrls } = extractLinksFromSearchPage(url, html);
        log(`取材記事ありクリニック発見: ${found.length}件`);
        found.forEach((u) => pushUnique(clinicUrls, clinicSeen, u));

        nextPageUrls.forEach((u) => {
            const key = normalizeUrl(u);
            if (!visitedPages.has(key) && !queuedSet.has(key)) {
                queue.push(key);
                queuedSet.add(key);
            }
        });

        await sleep(delaySec);
    }
    return clinicUrls;
}

/* ═══════════════════════════════════════════════════
   § 8  CSV / JSON エクスポート
   ═══════════════════════════════════════════════════ */

const CSV_HEADERS = [
    "医院名", "医師名", "診療科目", "住所", "都道府県", "エリア",
    "最寄駅", "電話番号", "診療時間", "休診日", "特徴", "紹介文",
    "クリニックURL", "取材記事URL", "緯度", "経度", "取得日時",
];

function encodeCsvField(value) {
    const text = value == null ? "" : String(value);
    if (text.includes('"') || text.includes(",") || text.includes("\n")) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

function toCsv(rows) {
    const lines = [CSV_HEADERS.join(",")];
    rows.forEach((row) => {
        lines.push(CSV_HEADERS.map((h) => encodeCsvField(row[h] ?? "")).join(","));
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

/* ═══════════════════════════════════════════════════
   § 9  メイン実行
   ═══════════════════════════════════════════════════ */

async function runScrape() {
    if (state.running) return;
    const startUrl   = ui.startUrl.value.trim();
    const maxPages   = Number(ui.maxPages.value)   || 50;
    const maxClinics = Number(ui.maxClinics.value) || 0;
    const delaySec   = Number(ui.delay.value)      || 0.5;

    try { new URL(startUrl); } catch { alert("開始URLが不正です。"); return; }

    state.running = true;
    state.rows    = [];
    ui.startBtn.disabled = true;
    ui.jsonBtn.disabled  = true;
    ui.csvBtn.disabled   = true;
    ui.log.textContent   = "";
    log("スクレイピング開始 [Doctors File]");

    try {
        const clinicUrls = await discoverClinicPages(startUrl, maxPages, delaySec);
        log(`取材記事ありクリニック 合計: ${clinicUrls.length}件`);

        const rows = [];
        for (let i = 0; i < clinicUrls.length; i++) {
            const clinicUrl = clinicUrls[i];
            setStatus(`クリニック解析: ${i + 1}/${clinicUrls.length}`);
            log(`クリニック取得: ${clinicUrl}`);
            try {
                const html   = await fetchHtml(clinicUrl);
                const record = extractClinicFromHtml(html, clinicUrl);
                rows.push(record);
                log(`抽出完了: ${record["医院名"] || clinicUrl}`);
            } catch (err) {
                log(`WARN 取得失敗: ${clinicUrl} (${errText(err)})`);
            }
            if (maxClinics > 0 && rows.length >= maxClinics) break;
            await sleep(delaySec);
        }

        state.rows = maxClinics > 0 ? rows.slice(0, maxClinics) : rows;
        setStatus(`完了: ${state.rows.length}件`);
        log(`完了: ${state.rows.length}件`);
        ui.jsonBtn.disabled = state.rows.length === 0;
        ui.csvBtn.disabled  = state.rows.length === 0;
    } catch (err) {
        setStatus("エラーで停止しました");
        log(`ERROR: ${errText(err)}`);
    } finally {
        state.running = false;
        ui.startBtn.disabled = false;
    }
}

/* ═══════════════════════════════════════════════════
   § 10 イベントリスナー
   ═══════════════════════════════════════════════════ */

ui.startBtn.addEventListener("click", runScrape);

ui.jsonBtn.addEventListener("click", () => {
    if (!state.rows.length) return;
    const date = new Date().toISOString().slice(0, 10);
    downloadText(
        `doctorsfile_clinics_${date}.json`,
        JSON.stringify(state.rows, null, 2),
        "application/json;charset=utf-8",
    );
});

ui.csvBtn.addEventListener("click", () => {
    if (!state.rows.length) return;
    const date = new Date().toISOString().slice(0, 10);
    downloadText(
        `doctorsfile_clinics_${date}.csv`,
        toCsv(state.rows),
        "text/csv;charset=utf-8",
    );
});
