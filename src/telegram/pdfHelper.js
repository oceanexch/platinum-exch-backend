"use strict";

const puppeteer = require("puppeteer");

let _browser = null;
async function getBrowser() {
  if (!_browser || !_browser.connected) {
    _browser = await puppeteer.launch({
      executablePath:
        "/root/.cache/puppeteer/chrome/linux-143.0.7499.169/chrome-linux64/chrome",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
      headless: "new",
    });
  }
  return _browser;
}

/**
 * Build a styled HTML table.
 */
function buildTableHtml(columns, rows, rowColors) {
  const escHtml = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  let h = `<table><thead><tr>${columns.map((c) => `<th>${escHtml(c)}</th>`).join("")}</tr></thead><tbody>`;
  rows.forEach((row, idx) => {
    const colorTag = rowColors && rowColors[idx];
    let rowClass = "";
    let rowStyle = "";
    if (colorTag === "buy") {
      rowStyle = ` style="background:#dbeeff;"`;
    } else if (colorTag === "sell") {
      rowStyle = ` style="background:#ffe8e8;"`;
    } else if (idx % 2 === 1) {
      rowStyle = ` style="background:#f4f8ff;"`;
    }
    h += `<tr${rowStyle}>${row.map((cell) => `<td>${escHtml(String(cell ?? "-"))}</td>`).join("")}</tr>`;
  });
  return h + "</tbody></table>";
}

function generateHTML(title, sections = [], subtitle = "") {
  const escHtml = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

  let body = "";
  sections.forEach((s) => {
    if (s.heading) body += `<div class="sec-title">${escHtml(s.heading)}</div>`;
    if (s.table)
      body += buildTableHtml(s.table.columns, s.table.rows, s.table.rowColors);
    if (s.text) body += `<p class="note">${escHtml(s.text)}</p>`;
  });

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
    <title>${escHtml(title)}</title>
    <style>
    :root {
        --primary: #0f172a;
        --secondary: #334155;
        --accent: #2563eb;
        --bg: #f8fafc;
        --card: #ffffff;
        --text: #1e293b;
        --border: #e2e8f0;
    }
    *{box-sizing:border-box;margin:0;padding:0; -webkit-print-color-adjust: exact; print-color-adjust: exact;}
    body{font-family:'Outfit',sans-serif;padding:0px;color:var(--text);background:var(--bg);line-height:1.5;display:block;width:fit-content;min-width:100%;margin:0;}
    .container{display:block;width:fit-content;min-width:100%;margin:0;background:var(--card);padding:0px;border-radius:16px;box-shadow:0 10px 25px rgba(0,0,0,0.05);border:1px solid var(--border);box-sizing:border-box;}
    .hdr{display:block;width:100%;background:linear-gradient(135deg,var(--primary),var(--secondary));color:#fff;padding:12px 16px;border-radius:12px;margin-bottom:1px;position:relative;overflow:hidden;height:fit-content}
    .hdr::after{content:'';position:absolute;top:0;right:0;width:150px;height:150px;background:rgba(255,255,255,0.05);border-radius:50%;transform:translate(50%,-50%)}
    .hdr h1{font-size:28px;font-weight:700;letter-spacing:-0.5px;margin:0;display:flex;align-items:center;gap:10px}
    .hdr h2{font-size:18px;opacity:.9;margin-top:4px;font-weight:400}
    .hdr .sub{font-size:13px;opacity:.7;margin-top:4px;font-style:italic}
    .meta{font-size:12px;color:#64748b;margin-bottom:10px;text-align:right;font-weight:400;margin-top:10px;display:block;}
    .sec-title{font-size:16px;font-weight:700;color:var(--primary);margin:25px 0 12px;border-left:4px solid var(--accent);padding-left:12px;text-transform:uppercase;letter-spacing:1px}
    .table-wrapper{display:block;overflow-x:hidden;border-radius:10px;border:1px solid var(--border);margin-bottom:0px;}
    table{width:100%;border-collapse:separate;border-spacing:0;background:transparent;}
    th{background:#f1f5f9;color:var(--secondary);padding:7px 8px;text-align:center;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid var(--border);white-space:nowrap;border-right:1px solid var(--border);}
    td{padding:6px 8px;text-align:center;border-bottom:1px solid var(--border);font-size:13px;transition:background 0.2s ease;white-space:nowrap;border-right:1px solid var(--border);}
    th:last-child, td:last-child{border-right:none;}
    th:first-child{border-top-left-radius:10px;}
    th:last-child{border-top-right-radius:10px;}
    tr:last-child td:first-child{border-bottom-left-radius:10px;}
    tr:last-child td:last-child{border-bottom-right-radius:10px;}
    tr:hover td{background:#f8fafc}
    .note{color:#64748b;font-size:12px;margin-top:8px;font-style:italic;display:block;padding-left:12px;border-left:2px solid var(--border)}
    .footer{font-size:11px;color:#94a3b8;text-align:center;margin-top:20px;border-top:1px solid var(--border);padding-top:5px;letter-spacing:0.5px}
    
    @media print {
        .table-wrapper { overflow: visible !important; }
        table { page-break-inside: auto; }
        tr { page-break-inside: avoid; page-break-after: auto; }
        thead { display: table-header-group; }
        tfoot { display: table-footer-group; }
    }
    
    @media (max-width: 600px) { 
        body{padding:0;margin:0;}
        .container{padding:0px;border-radius:16px;box-shadow:0 10px 25px rgba(0,0,0,0.05);border:1px solid var(--border);margin:0;}
        .hdr{padding:12px 16px;border-radius:12px;margin-bottom:0px;}
        .hdr h1{font-size:28px;}
        th, td{padding:7px 8px;font-size:11px}
        .meta{text-align:right;}
    }
    </style></head><body><div class="container">
    <div class="hdr">
        <h1><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAMAAABiM0N1AAAAllBMVEVHcExVrO5VrO5VrO5VrO5VrO5VrO5VrO5VrO5VrO5VrO4iZpkiZplVrO4iZpkiZplVrO4iZpkiZpkiZpkiZpkiZpkiZplVrO4iZplVrO4iZplVrO4iZpkiZpk8icQ4hL0sdKpVrO4iZpk8icQveK5SqOklap5Ln94ob6RIm9ksc6k1gLlCks5Po+NFltM/jck4hb4yfLTylKViAAAAIXRSTlMAIN9Qz79AYIDvEO+/nyAwMK9gQJ+AEK/fj3Bwz1BA31DIYdf8AAAB90lEQVR42u3X6XKbMBSGYTCLBPG+xlnafhIY707u/+ZCiLFcJGEJ/KMz9XsBzxwdEGM7j/6dwjCkr2HotjFc0uvgUkCHjZSY+KjWoa71MDSCsp4VFVNoi6i5QyLU5RsO5Qa4UeSZOF6E25HbzhKiNlIPuIcUBzCudk8LmBe59udKN3kZKgVah0JV9rFmPyU8M1pTqGQSdt36lOJSR7PoCHKcVVtxQRHTRaef18RzN+8tp444t1A5nsLZXpCn6fvc+Wkwnv4uh1JBHUiJeWaFIvoVoCg0emL8Ms5AcYCOBOk2fVA7guoFS6OBkhKaOBbJG8pKZ2rjEEjtSqhvAwWQWp2dkY3jQmrDzo1toFdI8UYn82teRhsnhv7hP9tAHuTWTaAl5FhZyxVh22TZUJQ0ePwhUPNid1vdD2DP7O8shaIDsx9pAdRtm73Y3Vj92djA4lskl67El99QgroTs5WgactE4zbQYcVEo74eiD1KwxoI2bX0NJtrHBohz4/1EDaFJKh+3W+hRQ2EbM3+ajSuWn8ClNVBSHes0tv0ZVLcmvnkfdZNUphBwCZh2tZHQIb01G6lZLZ7wAwSHXlSwZLTAbCBROlmzzlPkg/OjxkUOWjQA3pA/xHk4y75DsFdIk7bkcS/wGGE1kVD51tqPZOfO0UkaMWQb+MLoCCNuLnaMSMAAAAASUVORK5CYII=" alt="🌊" width="30" height="30" style="vertical-align:middle;flex:none"> Ocean Exchange</h1>
        <h2>${escHtml(title)}</h2>
        ${subtitle ? `<div class="sub">${escHtml(subtitle)}</div>` : ""}
    </div>
    ${body.replace(/<table>/g, '<div class="table-wrapper"><table>').replace(/<\/table>/g, "</table></div>")}
    <div class="meta">Report Generated: ${now}</div>
    <div class="footer">© ${new Date().getFullYear()} Ocean Exchange Trading Systems • Secure & Confidential</div>
    </div></body></html>`;
}

/**
 * Generate a PDF buffer.
 */
async function generatePDF(title, sections = [], subtitle = "") {
  const html = generateHTML(title, sections, subtitle);
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle0" });
    const buf = await page.pdf({
      format: "A4",
      landscape: true,
      scale: 1,
      printBackground: true,
      margin: { top: "0px", bottom: "0px", left: "0px", right: "0px" },
    });
    return Buffer.from(buf);
  } finally {
    await page.close();
  }
}

module.exports = { generatePDF, generateHTML, buildTableHtml };
