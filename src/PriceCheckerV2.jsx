import { useState, useCallback, useMemo } from "react";
import * as XLSX from "xlsx";

const CHILDRENWEAR = "Childrenwear Chloé";
const EPS = 0.01;
const PAGE_SIZE = 200;

// ─── Country ISO code → SAP Sales Org mapping ────────────────────────────────
// Source: Classeur2.xlsx — a SFCC pricebook like chl_be_eur_list (Belgium)
// must resolve to FRCH, not BECH (which doesn't exist in SAP).
const COUNTRY_TO_SALESORG = {
  al:"FRCH", am:"FRCH", au:"AUCH", at:"FRCH", bh:"AECH", be:"FRCH",
  bg:"FRCH", ca:"CACH", cl:"USCH", hr:"FRCH", cy:"FRCH", cz:"FRCH",
  dk:"FRCH", do:"USCH", ee:"FRCH", fi:"FRCH", fr:"FRCH", de:"DECH",
  gr:"FRCH", hk:"HKCH", hu:"FRCH", is:"FRCH", in:"USCH", ie:"FRCH",
  il:"USCH", it:"ITCH", jp:"JPCH", jo:"USCH", kz:"FRCH", sa:"SACH",
  kw:"KWCH", kg:"FRCH", lv:"FRCH", lt:"FRCH", lu:"FRCH", mo:"MOCH",
  mk:"FRCH", my:"MYCH", mt:"FRCH", md:"FRCH", mc:"FRCH", ma:"FRCH",
  nl:"NLCH", nz:"NZCH", no:"FRCH", ph:"PHCH", pl:"FRCH", pt:"FRCH",
  qa:"AECH", ro:"FRCH", rs:"FRCH", sg:"SGCH", sk:"FRCH", si:"FRCH",
  za:"USCH", kr:"KRCH", es:"ESCH", se:"FRCH", ch:"CHCH", tw:"TWCH",
  th:"THCH", tn:"FRCH", ae:"AECH", gb:"GBCH", uz:"FRCH", vn:"VNCH",
};

// Target currency per country ISO code (from Classeur2.xlsx "Currency cible")
const COUNTRY_TO_CURRENCY = {
  al:"EUR", am:"EUR", au:"AUD", at:"EUR", bh:"AED", be:"EUR",
  bg:"EUR", ca:"CAD", cl:"USD", hr:"EUR", cy:"EUR", cz:"EUR",
  dk:"EUR", do:"USD", ee:"EUR", fi:"EUR", fr:"EUR", de:"EUR",
  gr:"EUR", hk:"HKD", hu:"EUR", is:"EUR", in:"USD", ie:"EUR",
  il:"USD", it:"EUR", jp:"JPY", jo:"USD", kz:"EUR", sa:"SAR",
  kw:"KWD", kg:"EUR", lv:"EUR", lt:"EUR", lu:"EUR", mo:"MOP",
  mk:"EUR", my:"MYR", mt:"EUR", md:"EUR", mc:"EUR", ma:"EUR",
  nl:"EUR", nz:"NZD", no:"EUR", ph:"PHP", pl:"EUR", pt:"EUR",
  qa:"AED", ro:"EUR", rs:"EUR", sg:"SGD", sk:"EUR", si:"EUR",
  za:"USD", kr:"KRW", es:"EUR", se:"EUR", ch:"CHF", tw:"TWD",
  th:"THB", tn:"EUR", ae:"AED", gb:"GBP", uz:"EUR", vn:"USD",
};

// Resolve Sales Org from a pricebook-id like "chl_be_eur_list" → "FRCH"
function salesOrgFromPricebookId(pbId) {
  const m = pbId.match(/chl_([a-z]{2})_/i);
  if (!m) return null;
  return COUNTRY_TO_SALESORG[m[1].toLowerCase()] ?? null;
}

// Extract currency code from pricebook-id: "chl_kw_kwd_list" → "KWD"
function currencyFromPricebookId(pbId) {
  const m = pbId.match(/chl_[a-z]{2}_([a-z]+)_/i);
  return m ? m[1].toUpperCase() : null;
}

// Returns true if the pricebook's currency matches the target currency for its country
function isTargetCurrency(pbId) {
  const mc = pbId.match(/chl_([a-z]{2})_([a-z]+)_/i);
  if (!mc) return true; // can't determine → keep
  const target = COUNTRY_TO_CURRENCY[mc[1].toLowerCase()];
  return !target || mc[2].toUpperCase() === target;
}

// ─── Column mapping ───────────────────────────────────────────────────────────
// Maps internal field names to possible header labels in the SAP Excel.
// Add synonyms/variants here if SAP changes the column name in future exports.
const COLUMN_MAP = {
  salesOrg:   ["Sales Organization", "Sales Org.", "Sales Org", "SalesOrg"],
  article:    ["Article", "Article ID", "SKU", "Material"],
  pricingRef: ["Pricing Ref. Artl", "Pricing Ref", "Pricing Ref Artl", "Generic"],
  plc:        ["Prod.Life Cycle", "Prod.Life", "PLC", "Prod. Life", "Product Life", "Prod Life"],
  category:   ["Mdse Catgry Desc.", "Mdse Catgry Desc", "Category", "Merchandise Category Desc"],
  validFrom:  ["Valid From", "ValidFrom", "Valid from"],
  validTo:    ["Valid To", "ValidTo", "Valid to"],
  price:      ["ZRSP Rate", "Price", "Amount", "Rate"],
  currency:   ["Currency ZRSP", "Currency Z", "Currency", "Curr"],
};

// Finds the index of the first matching header (case-insensitive)
function findColIndex(headers, candidates) {
  for (const candidate of candidates) {
    const idx = headers.findIndex(h => h.trim().toLowerCase() === candidate.toLowerCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

// Resolves all column indices from the header row
// Returns { cols, missing } where missing = list of field names not found
function resolveColumns(headers) {
  const cols = {};
  const missing = [];
  for (const [field, candidates] of Object.entries(COLUMN_MAP)) {
    const idx = findColIndex(headers, candidates);
    if (idx === -1) missing.push({ field, tried: candidates });
    else cols[field] = idx;
  }
  return { cols, missing };
}

// ─── Date helper ──────────────────────────────────────────────────────────────
function isActiveAt(vf, vt, refDate) {
  if (!vf || !vt) return false;
  const d0 = new Date(refDate); d0.setHours(0,0,0,0);
  const makeD = v => { const d = v instanceof Date ? new Date(v) : new Date(v); d.setHours(0,0,0,0); return d; };
  return makeD(vf) <= d0 && d0 <= makeD(vt);
}

const fmt = v => (v !== null && v !== undefined && !isNaN(v)) ? Number(v).toFixed(2) : "—";

function fmtDate(d) {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  return `${String(dt.getDate()).padStart(2,"0")}/${String(dt.getMonth()+1).padStart(2,"0")}/${dt.getFullYear()}`;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

// ─── SAP Parser ───────────────────────────────────────────────────────────────
// Returns { data, colReport } where colReport describes resolved columns
function parseSAP(arrayBuffer, refDate) {
  const wb = XLSX.read(arrayBuffer, { type:"array", cellDates:true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const allRows = XLSX.utils.sheet_to_json(ws, { header:1 });
  if (!allRows.length) throw new Error("Fichier SAP vide.");

  // Detect header row (first non-empty row)
  const headerRow = allRows[0].map(h => String(h ?? "").trim());

  // Resolve columns by name
  const { cols, missing } = resolveColumns(headerRow);

  // If critical columns are missing, throw with details
  const critical = ["salesOrg","article","plc","validFrom","validTo","price"];
  const criticalMissing = missing.filter(m => critical.includes(m.field));
  if (criticalMissing.length > 0) {
    const details = criticalMissing.map(m => `"${m.field}" (essayé: ${m.tried.join(", ")})`).join(" | ");
    throw new Error(`Colonnes introuvables dans le fichier SAP : ${details}\n\nEn-têtes détectés : ${headerRow.filter(Boolean).join(", ")}`);
  }

  // Build column report for UI display
  const colReport = Object.entries(cols).map(([field, idx]) => ({
    field,
    header: headerRow[idx],
    col: String.fromCharCode(65 + idx), // A, B, C...
    idx,
  }));

  // Parse data rows
  // data    = rows filtered by ALL business rules (used for runChecks)
  // dqRows  = ALL non-PLC15 rows with parseable dates, regardless of check date
  //           → used for SAP DQ: detects present AND future date-range overlaps
  const data = [];
  const dqRows = [];

  const normDate = v => {
    if (!v) return null;
    const d = v instanceof Date ? new Date(v) : new Date(v);
    d.setHours(0, 0, 0, 0);
    return isNaN(d.getTime()) ? null : d;
  };

  for (let i = 1; i < allRows.length; i++) {
    const r = allRows[i];
    if (!r?.[cols.salesOrg] && !r?.[cols.article]) continue;

    const plc = String(r[cols.plc] ?? "").trim();
    if (plc === "15") continue;

    const vf = cols.validFrom !== undefined ? r[cols.validFrom] : null;
    const vt = cols.validTo   !== undefined ? r[cols.validTo]   : null;

    const salesOrg   = String(r[cols.salesOrg]   ?? "").trim();
    const article    = String(r[cols.article]     ?? "").trim();
    const pricingRef = cols.pricingRef !== undefined ? String(r[cols.pricingRef] ?? "").trim() : "";
    const category   = cols.category   !== undefined ? String(r[cols.category]   ?? "").trim() : "";
    const price      = parseFloat(String(r[cols.price] ?? "").replace(",", "."));
    const currency   = cols.currency   !== undefined ? String(r[cols.currency]   ?? "").trim() : "";

    if (!salesOrg || !article) continue;
    const isGeneric = !pricingRef;

    const validFrom = normDate(vf);
    const validTo   = normDate(vt);

    const row = {
      salesOrg, article,
      pricingRef: pricingRef || null,
      plc, category,
      price: isNaN(price) ? null : price,
      currency, isGeneric,
      validFrom, validTo,
    };

    // dqRows: all non-PLC15 rows with parseable dates (no isActiveAt filter)
    // → enables detection of FUTURE overlaps not yet active at check date
    if (validFrom && validTo) dqRows.push(row);

    // For the main check: only keep rows active at check date
    if (!isActiveAt(vf, vt, refDate)) continue;

    // data: also apply PLC 25 non-CW business rule (SKU rows ignored)
    if (plc === "25" && category !== CHILDRENWEAR && !isGeneric) continue;
    data.push(row);
  }

  return { data, dqRows, colReport, warnings: missing };
}

// ─── SFCC Parser ──────────────────────────────────────────────────────────────
// Stores ALL price entries per product with their optional dates.
// Resolution to a single price happens at analysis time with the check date.
// rawPrices: { pid: [{price, from, to}] }
//   - from/to = null → continuous price (always active, used as fallback)
//   - from/to = Date → dated price (active only within that window)
function parseSFCC(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "text/xml");
  const pbId = doc.querySelector("header")?.getAttribute("pricebook-id") ?? "";
  const salesOrg = salesOrgFromPricebookId(pbId);
  const rawPrices = {};

  doc.querySelectorAll("price-table").forEach(t => {
    const pid = (t.getAttribute("product-id")||"").trim();
    const amt = t.querySelector("amount");
    if (!pid || !amt) return;
    const price = parseFloat(amt.textContent.trim().replace(",","."));
    if (isNaN(price)) return;

    const fromEl = t.querySelector("online-from");
    const toEl   = t.querySelector("online-to");
    const from   = fromEl ? new Date(fromEl.textContent.trim()) : null;
    const to     = toEl   ? new Date(toEl.textContent.trim())   : null;

    if (!rawPrices[pid]) rawPrices[pid] = [];
    rawPrices[pid].push({ price, from, to });
  });

  return { pricebookId:pbId, salesOrg, rawPrices };
}

// ─── Multi-Pricebook Parser ───────────────────────────────────────────────────
// Parses a combined XML file containing multiple <pricebook> elements inside a
// root <pricebooks> element (Demandware/SFCC export format).
// Returns an array of pricebook objects, one per <pricebook> found.
function parseMultiPricebook(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "text/xml");

  // Support both namespaced and non-namespaced documents
  const NS = "http://www.demandware.com/xml/impex/pricebook/2006-10-31";
  const getEls = (parent, tag) => {
    const direct = parent.querySelectorAll(tag);
    if (direct.length) return Array.from(direct);
    return Array.from(parent.getElementsByTagNameNS(NS, tag));
  };

  const pricebookEls = getEls(doc, "pricebook");
  if (!pricebookEls.length) throw new Error("Aucun élément <pricebook> trouvé dans le fichier XML.");

  return pricebookEls.flatMap(pb => {
    const headerEl = getEls(pb, "header")[0];
    const pbId = headerEl?.getAttribute("pricebook-id") ?? "";
    const salesOrg = salesOrgFromPricebookId(pbId);

    const rawPrices = {};
    getEls(pb, "price-table").forEach(t => {
      const pid = (t.getAttribute("product-id") || "").trim();
      const amt = t.querySelector("amount") || getEls(t, "amount")[0];
      if (!pid || !amt) return;
      const price = parseFloat(amt.textContent.trim().replace(",", "."));
      if (isNaN(price)) return;

      const fromEl = t.querySelector("online-from") || getEls(t, "online-from")[0];
      const toEl   = t.querySelector("online-to")   || getEls(t, "online-to")[0];
      const from   = fromEl ? new Date(fromEl.textContent.trim()) : null;
      const to     = toEl   ? new Date(toEl.textContent.trim())   : null;

      if (!rawPrices[pid]) rawPrices[pid] = [];
      rawPrices[pid].push({ price, from, to });
    });

    // Ignore Sales pricebooks — keep only List pricebooks
    if (!pbId.endsWith("_list")) return [];

    // Ignore pricebooks whose country is not in the known mapping
    if (!salesOrg) return [];

    const currency = currencyFromPricebookId(pbId);
    return [{
      pricebookId: pbId,
      salesOrg,
      rawPrices,
      entryCount: Object.keys(rawPrices).length,
      currency,
      isTargetCcy: isTargetCurrency(pbId),
    }];
  });
}

// ─── SFCC Price Resolver ──────────────────────────────────────────────────────
// At a given checkDate, resolve each product's effective price:
//   1. Collect all dated entries active at checkDate
//   2. If multiple active dated entries → DQ issue (overlapping)
//      → type PRIX_DIFFERENTS if prices differ, PRIX_IDENTIQUES otherwise
//   3. If exactly one active dated entry → use it (priority over continuous)
//   4. If no active dated entry → use continuous price (no dates)
//   5. If neither → absent
// Returns { prices: {pid: price}, dqIssues: [{pid, salesOrg, entries, type}] }
function resolveSFCCPrices(rawPrices, checkDate) {
  const resolvedPrices = {};
  const dqIssues = [];
  const d0 = new Date(checkDate); d0.setHours(12,0,0,0);

  for (const [pid, entries] of Object.entries(rawPrices)) {
    const dated      = entries.filter(e => e.from !== null && e.to !== null);
    const continuous = entries.filter(e => e.from === null && e.to === null);

    // Find active dated entries at checkDate
    const activeDated = dated.filter(e => e.from <= d0 && d0 <= e.to);

    if (activeDated.length > 1) {
      // Classify: same price across all overlapping entries, or different?
      const priceVals = activeDated.map(e => e.price);
      const allSame   = priceVals.every(p => Math.abs(p - priceVals[0]) < EPS);
      dqIssues.push({
        pid,
        entries: activeDated,
        type: allSame ? "PRIX_IDENTIQUES" : "PRIX_DIFFERENTS",
      });
      // Use entry with most recent "from" date as the effective price
      const sorted = [...activeDated].sort((a, b) => b.from - a.from);
      resolvedPrices[pid] = sorted[0].price;
    } else if (activeDated.length === 1) {
      resolvedPrices[pid] = activeDated[0].price;
    } else if (continuous.length > 0) {
      resolvedPrices[pid] = continuous[0].price;
    }
    // else: no price at this date → pid not added → KO_MISSING
  }

  return { prices: resolvedPrices, dqIssues };
}

// ─── Check Engine ─────────────────────────────────────────────────────────────
function runChecks(sapData, sfccByOrg) {
  return sapData.map(row => {
    const sfcc = sfccByOrg[row.salesOrg] ?? {};
    const isCW = row.category === CHILDRENWEAR;
    let status = "KO_MISSING", sfccPrice = null, checkLevel = "", detail = "";

    sfccPrice  = sfcc[row.article] ?? null;
    checkLevel = (row.plc === "25" && !isCW) ? "Generic" : "SKU";

    if (sfccPrice === null) {
      status = "KO_MISSING";
      detail = checkLevel === "Generic" ? "Generic absent SFCC" : "Absent SFCC";
    } else if (row.price !== null && Math.abs(sfccPrice - row.price) < EPS) {
      status = "PASS";
    } else {
      status = "KO_DIFF";
      detail = row.price !== null ? `Prix différent — Δ ${(sfccPrice - row.price).toFixed(2)}` : "Prix SAP vide";
    }

    return { ...row, sfccPrice, status, checkLevel, detail };
  });
}

// ─── Export ───────────────────────────────────────────────────────────────────
function toExportRows(rows, checkDateLabel) {
  return rows.map(r => ({
    "Date de check":         checkDateLabel,
    "Sales Org":             r.salesOrg,
    "Article":               r.article,
    "Pricing Ref (Generic)": r.pricingRef ?? "",
    "PLC":                   r.plc,
    "Catégorie":             r.category,
    "SAP Prix":              r.price ?? "",
    "Devise":                r.currency,
    "SFCC Prix":             r.sfccPrice ?? "",
    "Niveau check":          r.checkLevel,
    "Status":                r.status,
    "Détail":                r.detail,
  }));
}
function doXLSX(rows, label, checkDateLabel) {
  const data = toExportRows(rows, checkDateLabel);
  const ws = XLSX.utils.json_to_sheet(data);
  ws["!cols"] = Object.keys(data[0]).map(() => ({ wch:22 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Price Check");
  XLSX.writeFile(wb, `chloe_v2_${label}_${new Date().toISOString().slice(0,10)}.xlsx`);
}
function doCSV(rows, label, checkDateLabel) {
  const data = toExportRows(rows, checkDateLabel);
  const hs = Object.keys(data[0]);
  const esc = v => `"${String(v).replace(/"/g,'""')}"`;
  const lines = [hs.map(esc).join(","), ...data.map(r => hs.map(h=>esc(r[h])).join(","))];
  const url = URL.createObjectURL(new Blob([lines.join("\n")], { type:"text/csv;charset=utf-8;" }));
  Object.assign(document.createElement("a"), { href:url, download:`chloe_v2_${label}_${new Date().toISOString().slice(0,10)}.csv` }).click();
  URL.revokeObjectURL(url);
}

// Raw export (pre-formatted DQ rows, no schema transform)
function doXLSXRaw(data, label) {
  if (!data.length) return;
  const ws = XLSX.utils.json_to_sheet(data);
  ws["!cols"] = Object.keys(data[0]).map(() => ({ wch:22 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "DQ Export");
  XLSX.writeFile(wb, `chloe_dq_${label}_${new Date().toISOString().slice(0,10)}.xlsx`);
}
function doCSVRaw(data, label) {
  if (!data.length) return;
  const hs = Object.keys(data[0]);
  const esc = v => `"${String(v).replace(/"/g,'""')}"`;
  const lines = [hs.map(esc).join(","), ...data.map(r => hs.map(h=>esc(r[h])).join(","))];
  const url = URL.createObjectURL(new Blob([lines.join("\n")], { type:"text/csv;charset=utf-8;" }));
  Object.assign(document.createElement("a"), { href:url, download:`chloe_dq_${label}_${new Date().toISOString().slice(0,10)}.csv` }).click();
  URL.revokeObjectURL(url);
}

// ─── UI Components ────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, color, onClick, active }) {
  return (
    <div onClick={onClick} style={{ background:active?"#0f1a0f":"#0f0f0f", border:active?"1px solid #C9A97A55":"1px solid #1a1a1a", padding:"14px 16px", cursor:onClick?"pointer":"default", transition:"all .2s" }}>
      <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"8px", color:"#444", letterSpacing:".18em", textTransform:"uppercase", marginBottom:"8px" }}>{label}</div>
      <div style={{ fontSize:"26px", fontWeight:300, color, lineHeight:1 }}>{value}</div>
      {sub && <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:"#333", marginTop:"5px" }}>{sub}</div>}
    </div>
  );
}

function ExportMenu({ rows, label, checkDateLabel, small }) {
  const [open, setOpen] = useState(false);
  const s = small
    ? { background:"transparent", border:"1px solid #C9A97A55", color:"#C9A97A", padding:"5px 10px", fontFamily:"'Montserrat',sans-serif", fontSize:"8px", letterSpacing:".12em", cursor:"pointer", textTransform:"uppercase", display:"flex", alignItems:"center", gap:"4px" }
    : { background:"transparent", border:"1px solid #C9A97A", color:"#C9A97A", padding:"7px 14px", fontFamily:"'Montserrat',sans-serif", fontSize:"9px", letterSpacing:".15em", cursor:"pointer", textTransform:"uppercase", display:"flex", alignItems:"center", gap:"6px" };
  return (
    <div style={{ position:"relative", display:"inline-block" }}>
      <button style={s} onClick={()=>setOpen(o=>!o)}>
        ↓ Export{!small && ` (${rows.length})`} <span style={{ opacity:.5 }}>{open?"▲":"▼"}</span>
      </button>
      {open && (
        <div style={{ position:"absolute", right:0, top:"100%", marginTop:"2px", background:"#111", border:"1px solid #2a2a2a", zIndex:99, minWidth:"130px" }}>
          {[
            { ext:"XLSX", icon:"📊", fn:()=>{ doXLSX(rows,label,checkDateLabel); setOpen(false); } },
            { ext:"CSV",  icon:"📄", fn:()=>{ doCSV(rows,label,checkDateLabel);  setOpen(false); } },
          ].map(({ ext, icon, fn }) => (
            <button key={ext} onClick={fn}
              style={{ display:"block", width:"100%", background:"transparent", border:"none", borderBottom:"1px solid #1a1a1a", color:"#ccc", padding:"9px 14px", fontFamily:"'Montserrat',sans-serif", fontSize:"10px", letterSpacing:".1em", textTransform:"uppercase", cursor:"pointer", textAlign:"left" }}
              onMouseEnter={e=>e.currentTarget.style.background="#1a1a1a"}
              onMouseLeave={e=>e.currentTarget.style.background="transparent"}
            >{icon} {ext}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// Export menu for pre-formatted DQ rows (bypasses toExportRows schema transform)
function ExportMenuRaw({ data, label, count }) {
  const [open, setOpen] = useState(false);
  const s = { background:"transparent", border:"1px solid #C9A97A55", color:"#C9A97A", padding:"5px 10px", fontFamily:"'Montserrat',sans-serif", fontSize:"8px", letterSpacing:".12em", cursor:"pointer", textTransform:"uppercase", display:"flex", alignItems:"center", gap:"4px" };
  return (
    <div style={{ position:"relative", display:"inline-block" }}>
      <button style={s} onClick={()=>setOpen(o=>!o)}>
        ↓ Export ({count}) <span style={{ opacity:.5 }}>{open?"▲":"▼"}</span>
      </button>
      {open && (
        <div style={{ position:"absolute", right:0, top:"100%", marginTop:"2px", background:"#111", border:"1px solid #2a2a2a", zIndex:99, minWidth:"130px" }}>
          {[
            { ext:"XLSX", icon:"📊", fn:()=>{ doXLSXRaw(data,label); setOpen(false); } },
            { ext:"CSV",  icon:"📄", fn:()=>{ doCSVRaw(data,label);  setOpen(false); } },
          ].map(({ ext, icon, fn }) => (
            <button key={ext} onClick={fn}
              style={{ display:"block", width:"100%", background:"transparent", border:"none", borderBottom:"1px solid #1a1a1a", color:"#ccc", padding:"9px 14px", fontFamily:"'Montserrat',sans-serif", fontSize:"10px", letterSpacing:".1em", textTransform:"uppercase", cursor:"pointer", textAlign:"left" }}
              onMouseEnter={e=>e.currentTarget.style.background="#1a1a1a"}
              onMouseLeave={e=>e.currentTarget.style.background="transparent"}
            >{icon} {ext}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusTag({ status }) {
  const cfg = {
    PASS:       { bg:"#0a1e0f", color:"#4CAF7A", label:"✓ PASS" },
    KO_DIFF:    { bg:"#1e0a0a", color:"#E05252", label:"✗ KO — prix différent" },
    KO_MISSING: { bg:"#1a0a14", color:"#E052A0", label:"✗ KO — absent SFCC" },
  };
  const c = cfg[status] ?? { bg:"#111", color:"#444", label:status };
  return <span style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", letterSpacing:".06em", padding:"2px 7px", textTransform:"uppercase", borderRadius:"1px", display:"inline-block", background:c.bg, color:c.color, whiteSpace:"nowrap" }}>{c.label}</span>;
}

// Column report panel shown after SAP file is loaded
function ColReport({ colReport, warnings }) {
  const [open, setOpen] = useState(false);
  const hasWarnings = warnings && warnings.length > 0;
  return (
    <div style={{ marginTop:"8px", maxWidth:"600px" }}>
      <button onClick={()=>setOpen(o=>!o)}
        style={{ background:"transparent", border:`1px solid ${hasWarnings?"#C9A97A44":"#1e2e1e"}`, color:hasWarnings?"#C9A97A":"#4CAF7A", padding:"5px 12px", fontFamily:"'Montserrat',sans-serif", fontSize:"9px", letterSpacing:".1em", cursor:"pointer", textTransform:"uppercase", display:"flex", alignItems:"center", gap:"6px" }}>
        {hasWarnings ? "⚠" : "✓"} Colonnes détectées {open?"▲":"▼"}
      </button>
      {open && (
        <div style={{ background:"#0d0d0d", border:"1px solid #1a1a1a", padding:"10px 14px", marginTop:"4px" }}>
          <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"8px", color:"#444", letterSpacing:".2em", textTransform:"uppercase", marginBottom:"8px" }}>Mapping colonnes résolu</div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:"6px 16px" }}>
            {colReport.map(c => (
              <div key={c.field} style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:"#666", display:"flex", gap:"6px" }}>
                <span style={{ color:"#C9A97A", minWidth:"90px" }}>{c.field}</span>
                <span style={{ color:"#4CAF7A" }}>Col {c.col}</span>
                <span style={{ color:"#333", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>"{c.header}"</span>
              </div>
            ))}
          </div>
          {hasWarnings && (
            <div style={{ marginTop:"10px", borderTop:"1px solid #1a1a1a", paddingTop:"8px" }}>
              <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"8px", color:"#C9A97A", letterSpacing:".15em", textTransform:"uppercase", marginBottom:"6px" }}>⚠ Colonnes optionnelles non trouvées</div>
              {warnings.map(w => (
                <div key={w.field} style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:"#555", lineHeight:"1.7" }}>
                  <span style={{ color:"#C9A97A88" }}>{w.field}</span> → essayé : {w.tried.join(", ")}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const css = `
  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,300&family=Montserrat:wght@300;400;500&display=swap');
  *{box-sizing:border-box;margin:0;padding:0;}
  ::-webkit-scrollbar{width:3px;height:3px;}::-webkit-scrollbar-track{background:#0a0a0a;}::-webkit-scrollbar-thumb{background:#C9A97A;}
  .uc{border:1px solid #1e1e1e;background:#0f0f0f;padding:18px;transition:all .3s;position:relative;cursor:pointer;}
  .uc:hover{border-color:#C9A97A44;}.uc.ok{border-color:#2a4a2a;background:#0b150b;}
  .uc input[type=file]{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;}
  .fb{background:transparent;border:1px solid #1e1e1e;color:#555;padding:5px 12px;cursor:pointer;font-family:'Montserrat',sans-serif;font-size:9px;letter-spacing:.1em;transition:all .2s;text-transform:uppercase;white-space:nowrap;}
  .fb.on{border-color:#C9A97A;color:#C9A97A;background:#C9A97A0d;}.fb:hover:not(.on){border-color:#C9A97A44;color:#C9A97A77;}
  .ab{background:#C9A97A;color:#0a0a0a;border:none;padding:12px 40px;font-family:'Montserrat',sans-serif;font-size:11px;font-weight:500;letter-spacing:.2em;text-transform:uppercase;cursor:pointer;transition:all .3s;}
  .ab:hover:not(:disabled){background:#DFC090;}.ab:disabled{background:#1e1e1e;color:#333;cursor:not-allowed;}
  .tr{border-bottom:1px solid #111;transition:background .1s;}.tr:hover{background:#0f0f0f;}
  .sr{background:#0f0f0f;border:1px solid #1e1e1e;color:#ccc;padding:6px 10px;font-family:'Montserrat',sans-serif;font-size:10px;outline:none;}
  .sr:focus{border-color:#C9A97A44;}.sr::placeholder{color:#282828;}
  .sel{background:#111;border:1px solid #1e1e1e;color:#999;padding:6px 10px;font-family:'Montserrat',sans-serif;font-size:10px;outline:none;}
  .sel:focus{border-color:#C9A97A44;}
  .chip{display:inline-flex;align-items:center;gap:6px;background:#111;border:1px solid #2a2a2a;padding:4px 8px;font-family:'Montserrat',sans-serif;font-size:9px;color:#888;}
  .chip.ok{border-color:#2a4a2a;color:#4CAF7A;}.chip.warn{border-color:#4a3a0a;color:#C9A97A;}
  .rm{background:none;border:none;color:#444;cursor:pointer;font-size:11px;padding:0 2px;}.rm:hover{color:#E05252;}
  .ovr{background:#0a0a0a;border:1px solid #C9A97A44;color:#C9A97A;padding:3px 6px;font-family:'Montserrat',sans-serif;font-size:9px;width:80px;outline:none;}
  .date-input{background:#0f0f0f;border:1px solid #C9A97A44;color:#F0EBE0;padding:8px 12px;font-family:'Montserrat',sans-serif;font-size:11px;outline:none;cursor:pointer;transition:border-color .2s;}
  .date-input:focus{border-color:#C9A97A;}
  .date-input::-webkit-calendar-picker-indicator{filter:invert(0.7) sepia(1) saturate(2) hue-rotate(5deg);cursor:pointer;}
`;

// ─── Main ─────────────────────────────────────────────────────────────────────
const PWD_KEY = "chloe_pc_auth";
const CORRECT_PWD = "ChloePriceCheck";

function LoginGate({ onAuth }) {
  const [val, setVal]   = useState("");
  const [err, setErr]   = useState(false);
  const [show, setShow] = useState(false);

  const submit = () => {
    if (val === CORRECT_PWD) {
      sessionStorage.setItem(PWD_KEY, "1");
      onAuth();
    } else {
      setErr(true);
      setVal("");
      setTimeout(() => setErr(false), 2000);
    }
  };

  return (
    <div style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", background:"#0a0a0a", minHeight:"100vh", color:"#F0EBE0", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;1,300&family=Montserrat:wght@300;400;500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
      `}</style>

      <div style={{ textAlign:"center", marginBottom:"40px" }}>
        <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", letterSpacing:".35em", color:"#C9A97A", textTransform:"uppercase", marginBottom:"10px" }}>Chloé · Digital Operations</div>
        <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:"32px", fontWeight:300, letterSpacing:".06em", color:"#F0EBE0", lineHeight:1.2 }}>
          Price Check <span style={{ fontStyle:"italic", color:"#C9A97A" }}>SAP ↔ SFCC</span>
        </div>
      </div>

      <div style={{ background:"#0f0f0f", border:`1px solid ${err?"#E0525255":"#C9A97A33"}`, padding:"28px 32px", width:"320px", transition:"border-color .3s" }}>
        <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"8px", color:"#555", letterSpacing:".2em", textTransform:"uppercase", marginBottom:"16px" }}>Accès restreint</div>

        <div style={{ position:"relative", marginBottom:"10px" }}>
          <input
            type={show ? "text" : "password"}
            value={val}
            onChange={e => { setVal(e.target.value); setErr(false); }}
            onKeyDown={e => e.key === "Enter" && submit()}
            placeholder="Mot de passe"
            autoFocus
            style={{ width:"100%", background:"#0a0a0a", border:`1px solid ${err?"#E05252":"#1e1e1e"}`, color:"#F0EBE0", padding:"10px 36px 10px 12px", fontFamily:"'Montserrat',sans-serif", fontSize:"11px", outline:"none", transition:"border-color .2s" }}
          />
          <button onClick={() => setShow(s => !s)}
            style={{ position:"absolute", right:"8px", top:"50%", transform:"translateY(-50%)", background:"none", border:"none", color:"#444", cursor:"pointer", fontSize:"13px", padding:"2px" }}>
            {show ? "🙈" : "👁"}
          </button>
        </div>

        {err && (
          <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:"#E05252", marginBottom:"10px", letterSpacing:".05em" }}>
            Mot de passe incorrect
          </div>
        )}

        <button onClick={submit}
          style={{ width:"100%", background:"#C9A97A", color:"#0a0a0a", border:"none", padding:"11px", fontFamily:"'Montserrat',sans-serif", fontSize:"10px", fontWeight:500, letterSpacing:".2em", textTransform:"uppercase", cursor:"pointer", marginTop:"4px" }}>
          Accéder
        </button>
      </div>

      <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"8px", color:"#1e1e1e", marginTop:"24px", letterSpacing:".1em" }}>
        Session active jusqu'à fermeture de l'onglet
      </div>
    </div>
  );
}

// Wrapper: handles auth only. PriceCheckerV2 mounts ONLY when authed,
// so its hooks are always called in consistent order (no Rules-of-Hooks violation).
export default function App() {
  const [authed, setAuthed] = useState(() => sessionStorage.getItem(PWD_KEY) === "1");
  if (!authed) return <LoginGate onAuth={() => setAuthed(true)} />;
  return <PriceCheckerV2 />;
}

function PriceCheckerV2() {
  const [sapRaw,       setSapRaw]       = useState(null);
  const [sapFileName,  setSapFileName]  = useState("");
  const [sapMeta,      setSapMeta]      = useState(null); // { colReport, warnings }
  const [xmlFiles,     setXmlFiles]     = useState([]);
  const [results,      setResults]      = useState(null);
  const [checkDateISO, setCheckDateISO] = useState(todayISO());
  const [appliedDate,  setAppliedDate]  = useState(null);
  const [sapCoverage,  setSapCoverage]  = useState(null);
  const [dqIssues,     setDqIssues]     = useState([]);
  const [sapDqIssues,  setSapDqIssues]  = useState([]);
  const [mode,            setMode]           = useState("standard"); // "standard" | "combined"
  const [splitResult,     setSplitResult]    = useState([]);         // parsed pricebooks from combined XML
  const [selectedPbs,     setSelectedPbs]    = useState(new Set());  // checked pricebook IDs
  const [orgOverrides,    setOrgOverrides]   = useState({});         // { pbId: "XXCH" }
  const [combinedXmlName, setCombinedXmlName]= useState("");
  const [loading,      setLoading]      = useState(false);
  const [loadMsg,      setLoadMsg]      = useState("");
  const [error,        setError]        = useState("");
  const [filterOrg,    setFilterOrg]    = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [search,       setSearch]       = useState("");
  const [page,         setPage]         = useState(0);

  // On SAP upload: just store the raw buffer + do a quick header scan
  const handleSAP = useCallback(e => {
    const file = e.target.files[0]; if (!file) return;
    setSapFileName(file.name); setSapMeta(null); setError("");
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        // Quick header scan to validate columns immediately
        const wb = XLSX.read(ev.target.result, { type:"array", sheetRows:1 });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const headerRow = XLSX.utils.sheet_to_json(ws, { header:1 })[0] ?? [];
        const headers = headerRow.map(h => String(h ?? "").trim());
        const { cols, missing } = resolveColumns(headers);
        const critical = ["salesOrg","article","plc","validFrom","validTo","price"];
        const criticalMissing = missing.filter(m => critical.includes(m.field));
        if (criticalMissing.length > 0) {
          const details = criticalMissing.map(m => `"${m.field}"`).join(", ");
          setError(`Colonnes critiques introuvables : ${details}. En-têtes détectés : ${headers.filter(Boolean).join(", ")}`);
          return;
        }
        const colReport = Object.entries(cols).map(([field, idx]) => ({
          field, header: headers[idx],
          col: idx < 26 ? String.fromCharCode(65+idx) : `Col${idx+1}`,
          idx,
        }));
        setSapMeta({ colReport, warnings: missing });
        setSapRaw(ev.target.result);
      } catch(err) { setError("Erreur SAP : "+err.message); }
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const handleXML = useCallback(e => {
    Array.from(e.target.files).forEach(file => {
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          const parsed = parseSFCC(ev.target.result);
          if (!parsed.pricebookId.endsWith("_list")) {
            setError(`"${file.name}" est un pricebook Sales — seuls les pricebooks List sont acceptés.`);
            return;
          }
          setXmlFiles(prev => prev.find(x=>x.pricebookId===parsed.pricebookId) ? prev : [...prev, { name:file.name, ...parsed, salesOrgOverride:"" }]);
          setError("");
        } catch(err) { setError("Erreur XML : "+err.message); }
      };
      reader.readAsText(file);
    });
    e.target.value = "";
  }, []);

  const removeXml   = id      => setXmlFiles(prev => prev.filter(x=>x.pricebookId!==id));
  const setOverride = (id, v) => setXmlFiles(prev => prev.map(x=>x.pricebookId===id?{...x,salesOrgOverride:v.toUpperCase()}:x));

  // Handler for combined XML upload (mode combiné)
  const handleCombinedXml = useCallback(e => {
    const file = e.target.files[0]; if (!file) return;
    setCombinedXmlName(file.name); setError("");
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const pbs = parseMultiPricebook(ev.target.result);
        if (!pbs.length) throw new Error("Aucun pricebook trouvé dans le fichier.");
        setSplitResult(pbs);
        // Pre-check only pricebooks whose currency matches the target currency
        // (e.g. for Kuwait: KWD ✅ pre-checked, USD ❌ pre-unchecked)
        setSelectedPbs(new Set(pbs.filter(p => p.isTargetCcy).map(p => p.pricebookId)));
        setOrgOverrides({});
      } catch(err) { setError("Erreur XML : " + err.message); }
    };
    reader.readAsText(file);
    e.target.value = "";
  }, []);

  const handleAnalyze = () => {
    if (!sapRaw)          { setError("Fichier SAP manquant."); return; }
    if (!xmlFiles.length) { setError("Aucun pricebook SFCC chargé."); return; }
    if (!checkDateISO)    { setError("Date de check manquante."); return; }
    setLoading(true); setLoadMsg("Analyse en cours…");
    const refDate = new Date(checkDateISO+"T00:00:00");
    setTimeout(() => {
      try {
        const { data: sapData, dqRows: sapDqRows } = parseSAP(sapRaw, refDate);

        // Capture all Sales Orgs present in SAP at the check date (before any filtering)
        const allSapOrgs = [...new Set(sapData.map(r => r.salesOrg))].sort();
        setSapCoverage(allSapOrgs);

        // ── SAP DQ: detect date-range overlaps (present AND future) ──
        // Group ALL non-PLC15 rows (dqRows) by salesOrg + article, then check pairwise
        // if any 2 rows for the same article have overlapping valid periods.
        // Condition: max(from1,from2) <= min(to1,to2) AND overlap not fully in the past
        const dqGrouped = {};
        sapDqRows.forEach(row => {
          const key = `${row.salesOrg}__${row.article}`;
          if (!dqGrouped[key]) dqGrouped[key] = [];
          dqGrouped[key].push(row);
        });
        const newSapDqIssues = [];
        for (const rows of Object.values(dqGrouped)) {
          if (rows.length < 2) continue;
          const conflicting = new Set();
          for (let i = 0; i < rows.length; i++) {
            for (let j = i + 1; j < rows.length; j++) {
              const a = rows[i], b = rows[j];
              const overlapStart = a.validFrom >= b.validFrom ? a.validFrom : b.validFrom;
              const overlapEnd   = a.validTo   <= b.validTo   ? a.validTo   : b.validTo;
              // Overlap exists and is not fully expired before check date
              if (overlapStart <= overlapEnd && overlapEnd >= refDate) {
                conflicting.add(i);
                conflicting.add(j);
              }
            }
          }
          if (conflicting.size > 0) {
            newSapDqIssues.push({
              salesOrg: rows[0].salesOrg,
              article:  rows[0].article,
              plc:      rows[0].plc,
              rows: [...conflicting].map(idx => rows[idx]),
            });
          }
        }
        setSapDqIssues(newSapDqIssues);

        // ── Deduplicate sapData for runChecks ──
        // If 2 rows survive all filters for the same (salesOrg+article), keep the most recent validFrom
        const checkGrouped = {};
        sapData.forEach(row => {
          const key = `${row.salesOrg}__${row.article}`;
          if (!checkGrouped[key]) checkGrouped[key] = [];
          checkGrouped[key].push(row);
        });
        const dedupedSapData = [];
        for (const rows of Object.values(checkGrouped)) {
          if (rows.length > 1) {
            const best = rows.reduce((a, b) =>
              (a.validFrom && b.validFrom && a.validFrom >= b.validFrom) ? a : b
            );
            dedupedSapData.push(best);
          } else {
            dedupedSapData.push(rows[0]);
          }
        }

        // ── SFCC DQ: resolve prices, collect overlaps per Sales Org ──
        const sfccByOrg  = {};
        const allDqIssues = [];
        xmlFiles.forEach(x => {
          const org = x.salesOrgOverride || x.salesOrg;
          if (!org) return;
          const { prices, dqIssues } = resolveSFCCPrices(x.rawPrices, refDate);
          sfccByOrg[org] = prices;
          dqIssues.forEach(issue => allDqIssues.push({ ...issue, salesOrg: org }));
        });
        setDqIssues(allDqIssues);

        // Run checks on de-duplicated SAP data
        setResults(runChecks(dedupedSapData, sfccByOrg));
        setAppliedDate(refDate);
        setFilterOrg("all"); setFilterStatus("all"); setSearch(""); setPage(0);
        setError("");
      } catch(err) { setError("Erreur : "+err.message); }
      setLoading(false);
    }, 50);
  };

  // ── Analyse mode combiné ────────────────────────────────────────────────────
  // Same SAP DQ + dedup logic; SFCC built from selectedPbs / splitResult.
  const handleAnalyzeCombined = () => {
    if (!sapRaw)           { setError("Fichier SAP manquant."); return; }
    if (!splitResult.length) { setError("Aucun pricebook chargé."); return; }
    if (!checkDateISO)     { setError("Date de check manquante."); return; }
    const activePbs = splitResult.filter(pb => selectedPbs.has(pb.pricebookId));
    if (!activePbs.length) { setError("Aucun pricebook sélectionné."); return; }

    setLoading(true); setLoadMsg("Analyse en cours…");
    const refDate = new Date(checkDateISO + "T00:00:00");
    setTimeout(() => {
      try {
        const { data: sapData, dqRows: sapDqRows } = parseSAP(sapRaw, refDate);

        const allSapOrgs = [...new Set(sapData.map(r => r.salesOrg))].sort();
        setSapCoverage(allSapOrgs);

        // SAP DQ — identical logic to standard mode
        const dqGrouped = {};
        sapDqRows.forEach(row => {
          const key = `${row.salesOrg}__${row.article}`;
          if (!dqGrouped[key]) dqGrouped[key] = [];
          dqGrouped[key].push(row);
        });
        const newSapDqIssues = [];
        for (const rows of Object.values(dqGrouped)) {
          if (rows.length < 2) continue;
          const conflicting = new Set();
          for (let i = 0; i < rows.length; i++) {
            for (let j = i + 1; j < rows.length; j++) {
              const a = rows[i], b = rows[j];
              const overlapStart = a.validFrom >= b.validFrom ? a.validFrom : b.validFrom;
              const overlapEnd   = a.validTo   <= b.validTo   ? a.validTo   : b.validTo;
              if (overlapStart <= overlapEnd && overlapEnd >= refDate) {
                conflicting.add(i); conflicting.add(j);
              }
            }
          }
          if (conflicting.size > 0) {
            newSapDqIssues.push({
              salesOrg: rows[0].salesOrg, article: rows[0].article, plc: rows[0].plc,
              rows: [...conflicting].map(idx => rows[idx]),
            });
          }
        }
        setSapDqIssues(newSapDqIssues);

        // Dedup SAP data
        const checkGrouped = {};
        sapData.forEach(row => {
          const key = `${row.salesOrg}__${row.article}`;
          if (!checkGrouped[key]) checkGrouped[key] = [];
          checkGrouped[key].push(row);
        });
        const dedupedSapData = [];
        for (const rows of Object.values(checkGrouped)) {
          if (rows.length > 1) {
            const best = rows.reduce((a, b) =>
              (a.validFrom && b.validFrom && a.validFrom >= b.validFrom) ? a : b
            );
            dedupedSapData.push(best);
          } else {
            dedupedSapData.push(rows[0]);
          }
        }

        // SFCC — from selected pricebooks
        const sfccByOrg = {};
        const allDqIssues = [];
        activePbs.forEach(pb => {
          const org = orgOverrides[pb.pricebookId] || pb.salesOrg;
          if (!org) return;
          const { prices, dqIssues } = resolveSFCCPrices(pb.rawPrices, refDate);
          sfccByOrg[org] = prices;
          dqIssues.forEach(issue => allDqIssues.push({ ...issue, salesOrg: org }));
        });
        setDqIssues(allDqIssues);

        setResults(runChecks(dedupedSapData, sfccByOrg));
        setAppliedDate(refDate);
        setFilterOrg("all"); setFilterStatus("all"); setSearch(""); setPage(0);
        setError("");
      } catch(err) { setError("Erreur : " + err.message); }
      setLoading(false);
    }, 50);
  };

  const stats = useMemo(() => {
    if (!results) return null;
    const orgs = [...new Set(results.map(r=>r.salesOrg))].sort();
    const byOrg = {};
    orgs.forEach(org => {
      const cr = results.filter(r=>r.salesOrg===org);
      byOrg[org] = { total:cr.length, pass:cr.filter(r=>r.status==="PASS").length, koDiff:cr.filter(r=>r.status==="KO_DIFF").length, koMiss:cr.filter(r=>r.status==="KO_MISSING").length };
      byOrg[org].ko = byOrg[org].koDiff + byOrg[org].koMiss;
    });
    const pass=results.filter(r=>r.status==="PASS").length, koDiff=results.filter(r=>r.status==="KO_DIFF").length, koMiss=results.filter(r=>r.status==="KO_MISSING").length;
    return { total:results.length, pass, koDiff, koMiss, ko:koDiff+koMiss, orgs, byOrg };
  }, [results]);

  // Coverage: SAP orgs vs uploaded pricebooks
  const coverage = useMemo(() => {
    if (!sapCoverage || !xmlFiles.length) return null;
    const uploadedOrgs = new Set(xmlFiles.map(x => x.salesOrgOverride || x.salesOrg).filter(Boolean));
    const matched = sapCoverage.filter(o => uploadedOrgs.has(o));
    const missing = sapCoverage.filter(o => !uploadedOrgs.has(o));
    const extra   = [...uploadedOrgs].filter(o => !sapCoverage.includes(o));
    return { matched, missing, extra };
  }, [sapCoverage, xmlFiles]);

  const filtered = useMemo(() => {
    if (!results) return [];
    return results.filter(r => {
      const ps = filterStatus==="all"?true:filterStatus==="KO"?(r.status==="KO_DIFF"||r.status==="KO_MISSING"):r.status===filterStatus;
      if (filterOrg!=="all" && r.salesOrg!==filterOrg) return false;
      if (!ps) return false;
      if (search) { const q=search.toLowerCase(); if (!r.article.toLowerCase().includes(q)&&!r.salesOrg.toLowerCase().includes(q)) return false; }
      return true;
    });
  }, [results, filterOrg, filterStatus, search]);

  const paged    = filtered.slice(0,(page+1)*PAGE_SIZE);
  const hasMore  = filtered.length > paged.length;
  const unmapped = xmlFiles.filter(x=>!x.salesOrg&&!x.salesOrgOverride);
  const checkDateLabel = appliedDate ? fmtDate(appliedDate) : "";
  const exportLabel = filterStatus!=="all"?filterStatus.toLowerCase():filterOrg!=="all"?filterOrg.toLowerCase():"complet";
  const isToday = checkDateISO===todayISO();

  return (
    <div style={{ fontFamily:"'Cormorant Garamond',Georgia,serif", background:"#0a0a0a", minHeight:"100vh", color:"#F0EBE0" }}>
      <style>{css}</style>

      <header style={{ borderBottom:"1px solid #141414", padding:"14px 28px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div>
          <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", letterSpacing:".35em", color:"#C9A97A", textTransform:"uppercase", marginBottom:"3px" }}>Chloé · Digital Operations</div>
          <h1 style={{ fontWeight:300, fontSize:"19px", letterSpacing:".06em", lineHeight:1 }}>
            Price Check <span style={{ fontStyle:"italic", color:"#C9A97A" }}>SAP ↔ SFCC</span>
            <span style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"10px", color:"#444", marginLeft:"12px", letterSpacing:".08em" }}>Multi-pays · Règles PLC</span>
          </h1>
        </div>
        <div style={{ display:"flex", gap:"8px", alignItems:"center" }}>
          {appliedDate && (
            <div style={{ background:"#141414", border:"1px solid #C9A97A33", padding:"6px 12px", display:"flex", alignItems:"center", gap:"8px" }}>
              <span style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"8px", color:"#555", letterSpacing:".15em", textTransform:"uppercase" }}>Check au</span>
              <span style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:"16px", color:"#C9A97A", fontWeight:300 }}>{checkDateLabel}</span>
              {isToday && <span style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"8px", color:"#4CAF7A", background:"#0a1e0f", padding:"1px 5px" }}>aujourd'hui</span>}
            </div>
          )}
          {results && (
            <>
              <button onClick={()=>{ setResults(null); setAppliedDate(null); setSapCoverage(null); setDqIssues([]); setSapDqIssues([]); setSplitResult([]); setSelectedPbs(new Set()); setOrgOverrides({}); setCombinedXmlName(""); }}
                style={{ background:"transparent", border:"1px solid #1e1e1e", color:"#555", padding:"7px 14px", fontFamily:"'Montserrat',sans-serif", fontSize:"9px", letterSpacing:".15em", cursor:"pointer", textTransform:"uppercase" }}>
                ← Reset
              </button>
              <ExportMenu rows={filtered} label={exportLabel} checkDateLabel={checkDateLabel} />
            </>
          )}
        </div>
      </header>

      {loading && (
        <div style={{ background:"#C9A97A11", borderBottom:"1px solid #C9A97A22", padding:"8px 28px", fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:"#C9A97A", letterSpacing:".15em", textTransform:"uppercase" }}>
          ⏳ {loadMsg}
        </div>
      )}

      <div style={{ padding:"22px 28px", maxWidth:"1600px" }}>

        {!results && (
          <>
            {/* ── Mode tabs ─────────────────────────────────────────────── */}
            <div style={{ display:"flex", gap:"0", marginBottom:"22px", borderBottom:"1px solid #1a1a1a" }}>
              {[
                { key:"standard", label:"Mode standard", sub:"Un XML par pays" },
                { key:"combined", label:"Mode fichier combiné", sub:"Un seul XML multi-pricebooks" },
              ].map(t => (
                <button key={t.key} onClick={()=>{ setMode(t.key); setError(""); }}
                  style={{ background:"transparent", border:"none", borderBottom:mode===t.key?"2px solid #C9A97A":"2px solid transparent", color:mode===t.key?"#C9A97A":"#444", padding:"10px 22px", fontFamily:"'Montserrat',sans-serif", fontSize:"9px", letterSpacing:".18em", textTransform:"uppercase", cursor:"pointer", transition:"all .2s" }}>
                  {t.label}
                  <div style={{ fontSize:"8px", color:mode===t.key?"#C9A97A66":"#2a2a2a", marginTop:"2px", letterSpacing:".1em" }}>{t.sub}</div>
                </button>
              ))}
            </div>

            {/* ── Mode standard ─────────────────────────────────────────── */}
            {mode === "standard" && (
              <div style={{ display:"flex", flexDirection:"column", gap:"18px" }}>

            {/* Date */}
            <div>
              <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", letterSpacing:".25em", color:"#C9A97A", textTransform:"uppercase", marginBottom:"7px" }}>① Date de check</div>
              <div style={{ display:"flex", alignItems:"center", gap:"12px", background:"#0f0f0f", border:"1px solid #C9A97A33", padding:"14px 18px", maxWidth:"420px" }}>
                <div style={{ fontSize:"18px" }}>📅</div>
                <div style={{ flex:1 }}>
                  <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:"#555", marginBottom:"6px", letterSpacing:".1em" }}>Vérifier l'alignement à cette date</div>
                  <input type="date" className="date-input" value={checkDateISO} onChange={e=>setCheckDateISO(e.target.value)} />
                </div>
                <div style={{ textAlign:"right" }}>
                  <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:"20px", color:"#C9A97A", fontWeight:300, lineHeight:1 }}>
                    {checkDateISO ? fmtDate(new Date(checkDateISO+"T00:00:00")) : "—"}
                  </div>
                  {isToday && <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"8px", color:"#4CAF7A", marginTop:"3px" }}>aujourd'hui</div>}
                </div>
              </div>
              <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:"#2a2a2a", marginTop:"5px" }}>
                Seules les lignes SAP avec Valid From ≤ date ≤ Valid To seront incluses.
              </div>
            </div>

            {/* SAP */}
            <div>
              <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", letterSpacing:".25em", color:"#C9A97A", textTransform:"uppercase", marginBottom:"7px" }}>② Fichier SAP (.xlsx)</div>
              <div className={`uc ${sapRaw?"ok":""}`} style={{ maxWidth:"600px" }}>
                <input type="file" accept=".xlsx,.xls" onChange={handleSAP} disabled={loading} />
                <div style={{ display:"flex", alignItems:"center", gap:"12px" }}>
                  <div style={{ fontSize:"20px", opacity:sapRaw?1:0.15 }}>📊</div>
                  <div>
                    <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"11px", color:sapRaw?"#4CAF7A":"#444" }}>
                      {sapRaw ? sapFileName : "Déposer ou cliquer"}
                    </div>
                    <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:sapRaw?"#4CAF7A88":"#282828", marginTop:"3px" }}>
                      {sapRaw ? "Colonnes détectées automatiquement par nom d'en-tête" : "Colonnes détectées automatiquement — résistant aux changements de position"}
                    </div>
                  </div>
                </div>
              </div>
              {sapMeta && <ColReport colReport={sapMeta.colReport} warnings={sapMeta.warnings} />}
            </div>

            {/* XMLs */}
            <div>
              <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", letterSpacing:".25em", color:"#C9A97A", textTransform:"uppercase", marginBottom:"7px" }}>③ Pricebooks SFCC (.xml) — multi-fichiers</div>
              <div className="uc" style={{ maxWidth:"600px", marginBottom:"10px" }}>
                <input type="file" accept=".xml" multiple onChange={handleXML} disabled={loading} />
                <div style={{ display:"flex", alignItems:"center", gap:"12px" }}>
                  <div style={{ fontSize:"20px", opacity:0.15 }}>🗂️</div>
                  <div>
                    <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"11px", color:"#444" }}>Déposer ou cliquer — sélection multiple</div>
                    <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:"#282828", marginTop:"3px" }}>Sales Org auto-détectée depuis le pricebook-id</div>
                  </div>
                </div>
              </div>
              {xmlFiles.length > 0 && (
                <div style={{ display:"flex", flexWrap:"wrap", gap:"8px" }}>
                  {xmlFiles.map(x => {
                    const org=x.salesOrgOverride||x.salesOrg;
                    return (
                      <div key={x.pricebookId} className={`chip ${org?"ok":"warn"}`}>
                        <span>🗂️</span>
                        <span style={{ maxWidth:"140px", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{x.name}</span>
                        {org
                          ? <span style={{ background:"#0a200a", border:"1px solid #2a4a2a", padding:"1px 5px", color:"#4CAF7A", fontWeight:500 }}>{org}</span>
                          : <span style={{ display:"flex", alignItems:"center", gap:"3px" }}>
                              <span style={{ color:"#C9A97A", fontSize:"8px" }}>Sales Org?</span>
                              <input className="ovr" value={x.salesOrgOverride} onChange={e=>setOverride(x.pricebookId,e.target.value)} placeholder="ex: AECH" />
                            </span>}
                        <span style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"8px", color:"#444" }}>{Object.keys(x.rawPrices).length.toLocaleString()} prix</span>
                        <button className="rm" onClick={()=>removeXml(x.pricebookId)}>✕</button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Règles */}
            <div style={{ maxWidth:"600px", background:"#0d0d0d", border:"1px solid #141414", padding:"12px 16px" }}>
              <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"8px", color:"#444", letterSpacing:".2em", textTransform:"uppercase", marginBottom:"8px" }}>Règles de check</div>
              {[
                { plc:"PLC 15",                    rule:"Ignoré — aucun check",                           color:"#333" },
                { plc:"PLC 25 · non-Childrenwear", rule:"Check Generic uniquement (ligne SKU ignorée)",    color:"#C9A97A" },
                { plc:"PLC 25 · Childrenwear",     rule:"Check SKU SAP = SKU SFCC · KO si absent",        color:"#5ab0f0" },
                { plc:"PLC 57 et autres",          rule:"Check SKU SAP = SKU SFCC · KO si absent",        color:"#a07de0" },
              ].map(r=>(
                <div key={r.plc} style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:"#555", lineHeight:"1.9", display:"flex", gap:"8px" }}>
                  <span style={{ color:r.color, minWidth:"210px", flexShrink:0 }}>{r.plc}</span>
                  <span>{r.rule}</span>
                </div>
              ))}
            </div>

            {error && <div style={{ maxWidth:"600px", fontFamily:"'Montserrat',sans-serif", fontSize:"10px", color:"#E05252", padding:"10px 14px", border:"1px solid #E0525222", background:"#E052520a", whiteSpace:"pre-line" }}>{error}</div>}
            {unmapped.length>0 && <div style={{ maxWidth:"600px", fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:"#C9A97A", padding:"8px 12px", border:"1px solid #C9A97A22", background:"#C9A97A08" }}>⚠ {unmapped.length} pricebook(s) sans Sales Org détectée</div>}

            <div><button className="ab" onClick={handleAnalyze} disabled={!sapRaw||!xmlFiles.length||!checkDateISO||loading}>{loading?"Analyse…":"Lancer l'analyse"}</button></div>
          </div>
            )} {/* end mode standard */}

            {/* ── Mode combiné ──────────────────────────────────────────── */}
            {mode === "combined" && (
              <div style={{ display:"flex", flexDirection:"column", gap:"18px" }}>

                {/* Date */}
                <div>
                  <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", letterSpacing:".25em", color:"#C9A97A", textTransform:"uppercase", marginBottom:"7px" }}>① Date de check</div>
                  <div style={{ display:"flex", alignItems:"center", gap:"12px", background:"#0f0f0f", border:"1px solid #C9A97A33", padding:"14px 18px", maxWidth:"420px" }}>
                    <div style={{ fontSize:"18px" }}>📅</div>
                    <div style={{ flex:1 }}>
                      <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:"#555", marginBottom:"6px", letterSpacing:".1em" }}>Vérifier l'alignement à cette date</div>
                      <input type="date" className="date-input" value={checkDateISO} onChange={e=>setCheckDateISO(e.target.value)} />
                    </div>
                    <div style={{ textAlign:"right" }}>
                      <div style={{ fontFamily:"'Cormorant Garamond',serif", fontSize:"20px", color:"#C9A97A", fontWeight:300, lineHeight:1 }}>
                        {checkDateISO ? fmtDate(new Date(checkDateISO+"T00:00:00")) : "—"}
                      </div>
                      {isToday && <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"8px", color:"#4CAF7A", marginTop:"3px" }}>aujourd'hui</div>}
                    </div>
                  </div>
                </div>

                {/* SAP */}
                <div>
                  <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", letterSpacing:".25em", color:"#C9A97A", textTransform:"uppercase", marginBottom:"7px" }}>② Fichier SAP (.xlsx)</div>
                  <div className={`uc ${sapRaw?"ok":""}`} style={{ maxWidth:"600px" }}>
                    <input type="file" accept=".xlsx,.xls" onChange={handleSAP} disabled={loading} />
                    <div style={{ display:"flex", alignItems:"center", gap:"12px" }}>
                      <div style={{ fontSize:"20px", opacity:sapRaw?1:0.15 }}>📊</div>
                      <div>
                        <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"11px", color:sapRaw?"#4CAF7A":"#444" }}>{sapRaw ? sapFileName : "Déposer ou cliquer"}</div>
                        <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:sapRaw?"#4CAF7A88":"#282828", marginTop:"3px" }}>Colonnes détectées automatiquement</div>
                      </div>
                    </div>
                  </div>
                  {sapMeta && <ColReport colReport={sapMeta.colReport} warnings={sapMeta.warnings} />}
                </div>

                {/* XML combiné */}
                <div>
                  <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", letterSpacing:".25em", color:"#C9A97A", textTransform:"uppercase", marginBottom:"7px" }}>③ Fichier XML combiné — tous les pricebooks</div>
                  <div className={`uc ${splitResult.length?"ok":""}`} style={{ maxWidth:"600px" }}>
                    <input type="file" accept=".xml" onChange={handleCombinedXml} disabled={loading} />
                    <div style={{ display:"flex", alignItems:"center", gap:"12px" }}>
                      <div style={{ fontSize:"20px", opacity:splitResult.length?1:0.15 }}>🗜️</div>
                      <div>
                        <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"11px", color:splitResult.length?"#4CAF7A":"#444" }}>
                          {splitResult.length ? combinedXmlName : "Déposer ou cliquer — fichier XML multi-pricebooks"}
                        </div>
                        <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:splitResult.length?"#4CAF7A88":"#282828", marginTop:"3px" }}>
                          {splitResult.length ? `${splitResult.length} pricebooks détectés` : "Tous les pricebooks pays en un seul fichier"}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Étape 2 — Confirmation des pricebooks */}
                {splitResult.length > 0 && (
                  <div style={{ maxWidth:"700px", background:"#0d0d0d", border:"1px solid #C9A97A33", padding:"16px 18px" }}>
                    <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:"#C9A97A", letterSpacing:".2em", textTransform:"uppercase", marginBottom:"14px" }}>
                      Pricebooks détectés — {combinedXmlName}
                    </div>

                    <div style={{ display:"flex", flexDirection:"column", gap:"6px", marginBottom:"14px" }}>
                      {splitResult.map(pb => {
                        const checked = selectedPbs.has(pb.pricebookId);
                        const orgVal  = orgOverrides[pb.pricebookId] ?? pb.salesOrg ?? "";
                        return (
                          <div key={pb.pricebookId} style={{ display:"flex", alignItems:"center", gap:"12px", padding:"8px 10px", background:checked?"#0f0f0f":"#080808", border:`1px solid ${checked?"#2a2a2a":"#111"}`, transition:"all .15s" }}>
                            {/* Checkbox */}
                            <input type="checkbox" checked={checked} onChange={e => {
                              setSelectedPbs(prev => {
                                const s = new Set(prev);
                                e.target.checked ? s.add(pb.pricebookId) : s.delete(pb.pricebookId);
                                return s;
                              });
                            }} style={{ accentColor:"#C9A97A", width:"14px", height:"14px", cursor:"pointer" }} />

                            {/* Pricebook ID */}
                            <span style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:checked?"#888":"#333", minWidth:"200px" }}>{pb.pricebookId}</span>

                            {/* Arrow */}
                            <span style={{ color:"#2a2a2a", fontSize:"10px" }}>→</span>

                            {/* Sales Org (editable) */}
                            <div style={{ display:"flex", alignItems:"center", gap:"6px" }}>
                              {pb.salesOrg
                                ? <span style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"10px", fontWeight:500, color:checked?"#C9A97A":"#444", background:checked?"#C9A97A11":"transparent", border:"1px solid #2a2a2a", padding:"2px 8px", minWidth:"52px", textAlign:"center" }}>{orgVal || "?"}</span>
                                : <span style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"8px", color:"#C9A97A" }}>Sales Org?</span>
                              }
                              <input
                                className="ovr"
                                value={orgOverrides[pb.pricebookId] ?? ""}
                                onChange={e => setOrgOverrides(prev => ({ ...prev, [pb.pricebookId]: e.target.value.toUpperCase() }))}
                                placeholder="corriger"
                                style={{ width:"70px" }}
                              />
                            </div>

                            {/* Currency badge */}
                            {pb.currency && (
                              <span style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"8px", padding:"2px 6px", background: pb.isTargetCcy ? "#0a1e0f" : "#1e1000", border:`1px solid ${pb.isTargetCcy ? "#2a4a2a" : "#4a2a00"}`, color: pb.isTargetCcy ? "#4CAF7A" : "#F0A030" }}>
                                {pb.currency}{!pb.isTargetCcy && " ⚠ devise non cible"}
                              </span>
                            )}

                            {/* Entry count */}
                            <span style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:"#444", marginLeft:"auto" }}>
                              {pb.entryCount.toLocaleString()} entrées
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    {/* Summary */}
                    <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:"#555", marginBottom:"14px", borderTop:"1px solid #1a1a1a", paddingTop:"10px" }}>
                      <span style={{ color:"#C9A97A" }}>{selectedPbs.size}</span> pricebook(s) sélectionné(s) —{" "}
                      <span style={{ color:"#C9A97A" }}>
                        {new Set(splitResult.filter(pb => selectedPbs.has(pb.pricebookId)).map(pb => orgOverrides[pb.pricebookId] || pb.salesOrg).filter(Boolean)).size}
                      </span> Sales Org(s) couvertes
                    </div>

                    {error && <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"10px", color:"#E05252", padding:"8px 12px", border:"1px solid #E0525222", background:"#E052520a", marginBottom:"10px", whiteSpace:"pre-line" }}>{error}</div>}

                    <button className="ab" onClick={handleAnalyzeCombined}
                      disabled={!sapRaw || !selectedPbs.size || !checkDateISO || loading}>
                      {loading ? "Analyse…" : "Lancer l'analyse →"}
                    </button>
                  </div>
                )}

                {!splitResult.length && error && (
                  <div style={{ maxWidth:"600px", fontFamily:"'Montserrat',sans-serif", fontSize:"10px", color:"#E05252", padding:"10px 14px", border:"1px solid #E0525222", background:"#E052520a", whiteSpace:"pre-line" }}>{error}</div>
                )}
              </div>
            )} {/* end mode combined */}
          </>
        )}

        {/* RESULTS */}
        {results && stats && (
          <>
            {/* Coverage summary */}
            {coverage && (
              <div style={{ marginBottom:"16px", background:"#0d0d0d", border:"1px solid #1a1a1a", padding:"14px 18px" }}>
                <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:"#444", letterSpacing:".2em", textTransform:"uppercase", marginBottom:"12px" }}>
                  Résumé de la couverture — fichiers uploadés
                </div>
                <div style={{ display:"flex", gap:"24px", flexWrap:"wrap" }}>

                  <div style={{ flex:1, minWidth:"180px" }}>
                    <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"8px", color:"#4CAF7A", letterSpacing:".15em", textTransform:"uppercase", marginBottom:"6px" }}>
                      ✓ Pricebook chargé — inclus dans les KPIs ({coverage.matched.length})
                    </div>
                    <div style={{ display:"flex", flexWrap:"wrap", gap:"5px" }}>
                      {coverage.matched.map(org => (
                        <span key={org} style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", background:"#0a1e0f", border:"1px solid #2a4a2a", color:"#4CAF7A", padding:"2px 8px" }}>{org}</span>
                      ))}
                      {coverage.matched.length === 0 && <span style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:"#333" }}>—</span>}
                    </div>
                  </div>

                  {coverage.missing.length > 0 && (
                    <div style={{ flex:1, minWidth:"180px" }}>
                      <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"8px", color:"#E052A0", letterSpacing:".15em", textTransform:"uppercase", marginBottom:"6px" }}>
                        ✗ Pricebook manquant — non inclus dans les KPIs ({coverage.missing.length})
                      </div>
                      <div style={{ display:"flex", flexWrap:"wrap", gap:"5px", marginBottom:"6px" }}>
                        {coverage.missing.map(org => (
                          <span key={org} style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", background:"#1a0a14", border:"1px solid #4a1a3a", color:"#E052A0", padding:"2px 8px" }}>{org}</span>
                        ))}
                      </div>
                      <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:"#444", lineHeight:"1.6" }}>
                        Ces Sales Orgs existent dans SAP mais aucun pricebook SFCC correspondant n'a été uploadé. Leurs lignes sont exclues des résultats et des KPIs.
                      </div>
                    </div>
                  )}

                  {coverage.extra.length > 0 && (
                    <div style={{ flex:1, minWidth:"180px" }}>
                      <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"8px", color:"#C9A97A", letterSpacing:".15em", textTransform:"uppercase", marginBottom:"6px" }}>
                        ⚠ Pricebook sans données SAP ({coverage.extra.length})
                      </div>
                      <div style={{ display:"flex", flexWrap:"wrap", gap:"5px", marginBottom:"6px" }}>
                        {coverage.extra.map(org => (
                          <span key={org} style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", background:"#1a1500", border:"1px solid #4a3a0a", color:"#C9A97A", padding:"2px 8px" }}>{org}</span>
                        ))}
                      </div>
                      <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:"#444", lineHeight:"1.6" }}>
                        Pricebooks uploadés pour lesquels aucune ligne SAP n'existe à la date de check.
                      </div>
                    </div>
                  )}

                </div>
              </div>
            )}

            <div style={{ display:"grid", gridTemplateColumns:`repeat(${4+(dqIssues.length>0?1:0)+(sapDqIssues.length>0?1:0)},1fr)`, gap:"8px", marginBottom:"8px" }}>
              <KpiCard label="Total vérifiés"      value={stats.total.toLocaleString()}  color="#F0EBE0" sub={`Actifs au ${checkDateLabel}`} />
              <KpiCard label="PASS"                value={stats.pass.toLocaleString()}   color="#4CAF7A" sub={`${((stats.pass/stats.total)*100).toFixed(1)}% alignés`} onClick={()=>{setFilterStatus("PASS");setPage(0);}} active={filterStatus==="PASS"} />
              <KpiCard label="KO — prix différent" value={stats.koDiff.toLocaleString()} color="#E05252" sub="présent mais mauvais prix"    onClick={()=>{setFilterStatus("KO_DIFF");setPage(0);}} active={filterStatus==="KO_DIFF"} />
              <KpiCard label="KO — absent SFCC"    value={stats.koMiss.toLocaleString()} color="#E052A0" sub="manquant dans pricebook"       onClick={()=>{setFilterStatus("KO_MISSING");setPage(0);}} active={filterStatus==="KO_MISSING"} />
              {sapDqIssues.length > 0 && (
                <KpiCard
                  label="⚠ DQ SAP — lignes chevauchantes"
                  value={sapDqIssues.length.toLocaleString()}
                  color="#F0A030"
                  sub="articles comptés plusieurs fois"
                />
              )}
              {dqIssues.length > 0 && (() => {
                const nDiff = dqIssues.filter(d => d.type === "PRIX_DIFFERENTS").length;
                const nSame = dqIssues.filter(d => d.type === "PRIX_IDENTIQUES").length;
                return (
                  <KpiCard
                    label="⚠ DQ SFCC — dates chevauchantes"
                    value={dqIssues.length.toLocaleString()}
                    color={nDiff > 0 ? "#E05252" : "#F0A030"}
                    sub={nDiff > 0 ? `dont ${nDiff} prix différents` : `${nSame} prix identiques`}
                  />
                );
              })()}
            </div>

            <div style={{ display:"flex", height:"2px", marginBottom:"16px", gap:"1px" }}>
              <div style={{ flex:stats.pass,   background:"#4CAF7A" }} />
              <div style={{ flex:stats.koDiff, background:"#E05252" }} />
              <div style={{ flex:stats.koMiss, background:"#E052A0" }} />
            </div>

            {/* DQ SAP panel */}
            {sapDqIssues.length > 0 && (() => {
              const sapDqExportData = sapDqIssues.map(d => ({
                "Date de check":       checkDateLabel,
                "Sales Org":           d.salesOrg,
                "Article":             d.article,
                "PLC":                 d.plc,
                "Ligne 1 Prix":        d.rows[0]?.price ?? "",
                "Ligne 1 Valid From":  d.rows[0]?.validFrom ? fmtDate(d.rows[0].validFrom) : "",
                "Ligne 1 Valid To":    d.rows[0]?.validTo   ? fmtDate(d.rows[0].validTo)   : "",
                "Ligne 2 Prix":        d.rows[1]?.price ?? "",
                "Ligne 2 Valid From":  d.rows[1]?.validFrom ? fmtDate(d.rows[1].validFrom) : "",
                "Ligne 2 Valid To":    d.rows[1]?.validTo   ? fmtDate(d.rows[1].validTo)   : "",
              }));
              return (
                <div style={{ background:"#130e00", border:"1px solid #F0A03044", padding:"14px 16px", marginBottom:"10px" }}>
                  <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", flexWrap:"wrap", gap:"10px", marginBottom:"10px" }}>
                    <div>
                      <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:"#F0A030", letterSpacing:".2em", textTransform:"uppercase", marginBottom:"4px" }}>
                        ⚠ Data Quality — Lignes SAP chevauchantes
                      </div>
                      <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"10px", color:"#ccc", lineHeight:"1.6" }}>
                        <strong style={{ color:"#F0A030", fontFamily:"'Cormorant Garamond',serif", fontSize:"16px", fontWeight:300 }}>{sapDqIssues.length}</strong> article(s) ont des plages de dates qui se chevauchent dans SAP.
                        Certains chevauchements peuvent être dans le futur, pouvant impacter les prix dès leur activation.
                        La ligne avec la <strong>Valid From la plus récente</strong> est retenue pour le check actuel.
                      </div>
                    </div>
                    <ExportMenuRaw data={sapDqExportData} label="sap_chevauchements" count={sapDqIssues.length} />
                  </div>
                  <div style={{ overflowX:"auto" }}>
                    <table style={{ width:"100%", borderCollapse:"collapse", fontSize:"10px" }}>
                      <thead>
                        <tr style={{ background:"#0c0c0c", borderBottom:"1px solid #1a1a1a" }}>
                          {["Sales Org","Article","PLC","Ligne 1 Prix","L1 Valid From","L1 Valid To","Ligne 2 Prix","L2 Valid From","L2 Valid To"].map(h=>(
                            <th key={h} style={{ padding:"6px 10px", fontFamily:"'Montserrat',sans-serif", fontSize:"8px", letterSpacing:".1em", color:"#F0A030", textTransform:"uppercase", fontWeight:500, textAlign:"left", whiteSpace:"nowrap" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sapDqIssues.slice(0,15).map((d,i) => (
                          <tr key={i} style={{ borderBottom:"1px solid #111" }}>
                            <td style={{ padding:"5px 10px", fontFamily:"'Montserrat',sans-serif", color:"#C9A97A88" }}>{d.salesOrg}</td>
                            <td style={{ padding:"5px 10px", fontFamily:"'Montserrat',sans-serif", color:"#ddd", whiteSpace:"nowrap" }}>{d.article}</td>
                            <td style={{ padding:"5px 10px", fontFamily:"'Montserrat',sans-serif", color:"#666" }}>{d.plc}</td>
                            {[0,1].map(idx => (
                              <>
                                <td key={`p${idx}`} style={{ padding:"5px 10px", fontFamily:"'Montserrat',sans-serif", color: idx===0?"#4CAF7A":"#F0A030", fontWeight:500 }}>{d.rows[idx]?.price != null ? fmt(d.rows[idx].price) : "—"}</td>
                                <td key={`f${idx}`} style={{ padding:"5px 10px", fontFamily:"'Montserrat',sans-serif", color:"#555", whiteSpace:"nowrap" }}>{d.rows[idx]?.validFrom ? fmtDate(d.rows[idx].validFrom) : "—"}</td>
                                <td key={`t${idx}`} style={{ padding:"5px 10px", fontFamily:"'Montserrat',sans-serif", color:"#555", whiteSpace:"nowrap" }}>{d.rows[idx]?.validTo   ? fmtDate(d.rows[idx].validTo)   : "—"}</td>
                              </>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {sapDqIssues.length > 15 && (
                    <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:"#555", marginTop:"8px" }}>
                      +{sapDqIssues.length - 15} autres — voir export complet
                    </div>
                  )}
                </div>
              );
            })()}

            {/* DQ SFCC panel — deux sections : prix différents (critique) + identiques (bruit) */}
            {dqIssues.length > 0 && (() => {
              const diff = dqIssues.filter(d => d.type === "PRIX_DIFFERENTS");
              const same = dqIssues.filter(d => d.type === "PRIX_IDENTIQUES");
              const sfccDqExportData = dqIssues.map(d => ({
                "Date de check":  checkDateLabel,
                "Sales Org":      d.salesOrg,
                "Article":        d.pid,
                "Prix 1":         d.entries[0]?.price ?? "",
                "Date début 1":   d.entries[0]?.from ? fmtDate(d.entries[0].from) : "",
                "Date fin 1":     d.entries[0]?.to   ? fmtDate(d.entries[0].to)   : "",
                "Prix 2":         d.entries[1]?.price ?? "",
                "Date début 2":   d.entries[1]?.from ? fmtDate(d.entries[1].from) : "",
                "Date fin 2":     d.entries[1]?.to   ? fmtDate(d.entries[1].to)   : "",
                "Type":           d.type,
              }));
              return (
                <div style={{ background:"#120800", border:"1px solid #E0525233", padding:"14px 16px", marginBottom:"10px" }}>
                  <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", flexWrap:"wrap", gap:"10px", marginBottom:"12px" }}>
                    <div>
                      <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:"#F0A030", letterSpacing:".2em", textTransform:"uppercase", marginBottom:"4px" }}>
                        ⚠ Data Quality — Prix SFCC chevauchants
                      </div>
                      <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"10px", color:"#ccc" }}>
                        <strong style={{ color:"#F0A030", fontFamily:"'Cormorant Garamond',serif", fontSize:"16px", fontWeight:300 }}>{dqIssues.length}</strong> produit(s) ont plusieurs prix datés actifs simultanément dans SFCC.
                        Le prix avec la date de début la plus récente a été retenu pour le check.
                      </div>
                    </div>
                    <ExportMenuRaw data={sfccDqExportData} label="sfcc_chevauchements" count={dqIssues.length} />
                  </div>

                  {/* Section 1 — Prix différents (critique) */}
                  {diff.length > 0 && (
                    <div style={{ marginBottom:"12px" }}>
                      <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"8px", color:"#E05252", letterSpacing:".18em", textTransform:"uppercase", marginBottom:"6px", display:"flex", alignItems:"center", gap:"8px" }}>
                        <span style={{ background:"#E0525222", border:"1px solid #E0525244", padding:"2px 7px" }}>⛔ Prix différents — {diff.length} produit(s) — à corriger en urgence</span>
                      </div>
                      <div style={{ display:"flex", flexWrap:"wrap", gap:"4px" }}>
                        {diff.slice(0,30).map(d => (
                          <span key={d.pid+d.salesOrg} style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", background:"#1e0a0a", border:"1px solid #E0525255", color:"#E05252", padding:"3px 8px" }} title={d.entries.map(e=>`${e.price} (${fmtDate(e.from)}→${fmtDate(e.to)})`).join(" | ")}>
                            {d.salesOrg} · {d.pid}
                            <span style={{ color:"#E0525288", marginLeft:"4px", fontSize:"8px" }}>
                              {d.entries.map(e=>fmt(e.price)).join(" / ")}
                            </span>
                          </span>
                        ))}
                        {diff.length > 30 && <span style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:"#555" }}>+{diff.length-30} autres</span>}
                      </div>
                    </div>
                  )}

                  {/* Section 2 — Prix identiques (bruit de config) */}
                  {same.length > 0 && (
                    <div>
                      <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"8px", color:"#C9A97A", letterSpacing:".18em", textTransform:"uppercase", marginBottom:"6px", display:"flex", alignItems:"center", gap:"8px" }}>
                        <span style={{ background:"#C9A97A11", border:"1px solid #C9A97A33", padding:"2px 7px" }}>⚠ Prix identiques — {same.length} produit(s) — bruit de configuration, pas d'impact prix</span>
                      </div>
                      <div style={{ display:"flex", flexWrap:"wrap", gap:"4px" }}>
                        {same.slice(0,30).map(d => (
                          <span key={d.pid+d.salesOrg} style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", background:"#111", border:"1px solid #C9A97A22", color:"#C9A97A77", padding:"3px 8px" }}>
                            {d.salesOrg} · {d.pid}
                          </span>
                        ))}
                        {same.length > 30 && <span style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:"#555" }}>+{same.length-30} autres</span>}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

            <div style={{ marginBottom:"14px", overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:"11px" }}>
                <thead>
                  <tr style={{ background:"#0c0c0c", borderBottom:"1px solid #1a1a1a" }}>
                    {["Sales Org","Vérifiés","PASS","KO total","dont prix diff.","dont absents SFCC"].map(h=>(
                      <th key={h} style={{ padding:"7px 12px", fontFamily:"'Montserrat',sans-serif", fontSize:"8px", letterSpacing:".12em", color:"#C9A97A", textTransform:"uppercase", fontWeight:500, textAlign:"left" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {stats.orgs.map(org=>{
                    const o=stats.byOrg[org];
                    return (
                      <tr key={org} className="tr" style={{ cursor:"pointer" }} onClick={()=>{setFilterOrg(org);setPage(0);}}>
                        <td style={{ padding:"6px 12px", fontFamily:"'Montserrat',sans-serif", color:"#C9A97A" }}>{org}</td>
                        <td style={{ padding:"6px 12px", fontFamily:"'Montserrat',sans-serif", color:"#888" }}>{o.total.toLocaleString()}</td>
                        <td style={{ padding:"6px 12px", fontFamily:"'Montserrat',sans-serif", color:"#4CAF7A" }}>{o.pass.toLocaleString()}</td>
                        <td style={{ padding:"6px 12px", fontFamily:"'Montserrat',sans-serif", color:o.ko>0?"#E05252":"#333", fontWeight:o.ko>0?500:300 }}>{o.ko.toLocaleString()}</td>
                        <td style={{ padding:"6px 12px", fontFamily:"'Montserrat',sans-serif", color:o.koDiff>0?"#E05252":"#333" }}>{o.koDiff.toLocaleString()}</td>
                        <td style={{ padding:"6px 12px", fontFamily:"'Montserrat',sans-serif", color:o.koMiss>0?"#E052A0":"#333" }}>{o.koMiss.toLocaleString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ display:"flex", gap:"6px", marginBottom:"10px", flexWrap:"wrap", alignItems:"center" }}>
              <select className="sel" value={filterOrg} onChange={e=>{setFilterOrg(e.target.value);setPage(0);}}>
                <option value="all">Toutes Sales Org</option>
                {stats.orgs.map(o=><option key={o} value={o}>{o}</option>)}
              </select>
              <div style={{ display:"flex", gap:"5px", flexWrap:"wrap" }}>
                {[
                  { key:"all",        label:`Tout — ${filtered.length}` },
                  { key:"PASS",       label:`PASS — ${stats.pass}` },
                  { key:"KO",         label:`KO total — ${stats.ko}` },
                  { key:"KO_DIFF",    label:`Prix diff. — ${stats.koDiff}` },
                  { key:"KO_MISSING", label:`Absents — ${stats.koMiss}` },
                ].map(f=>(
                  <button key={f.key} className={`fb ${filterStatus===f.key?"on":""}`} onClick={()=>{setFilterStatus(f.key);setPage(0);}}>{f.label}</button>
                ))}
              </div>
              <input className="sr" style={{ width:"200px" }} placeholder="Rechercher Article…" value={search} onChange={e=>{setSearch(e.target.value);setPage(0);}} />
              <span style={{ marginLeft:"auto", fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:"#333" }}>{filtered.length.toLocaleString()} ligne(s)</span>
              <ExportMenu rows={filtered} label={exportLabel} checkDateLabel={checkDateLabel} />
            </div>

            <div style={{ border:"1px solid #141414", overflowX:"auto", maxHeight:"500px", overflowY:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:"12px" }}>
                <thead style={{ position:"sticky", top:0, zIndex:1 }}>
                  <tr style={{ background:"#0c0c0c", borderBottom:"1px solid #222" }}>
                    {["Sales Org","Article","PricingRef","PLC","Catégorie","SAP Prix","Devise","SFCC Prix","Niveau","Status","Détail"].map(h=>(
                      <th key={h} style={{ padding:"8px 11px", fontFamily:"'Montserrat',sans-serif", fontSize:"8px", letterSpacing:".12em", color:"#C9A97A", textTransform:"uppercase", fontWeight:500, textAlign:"left", whiteSpace:"nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {paged.map((row,i)=>(
                    <tr key={i} className="tr">
                      <td style={{ padding:"7px 11px", fontFamily:"'Montserrat',sans-serif", fontSize:"10px", color:"#C9A97A88", whiteSpace:"nowrap" }}>{row.salesOrg}</td>
                      <td style={{ padding:"7px 11px", fontFamily:"'Montserrat',sans-serif", fontSize:"11px", color:"#ddd", whiteSpace:"nowrap" }}>{row.article}</td>
                      <td style={{ padding:"7px 11px", fontFamily:"'Montserrat',sans-serif", fontSize:"10px", color:"#555", whiteSpace:"nowrap" }}>{row.pricingRef??"—"}</td>
                      <td style={{ padding:"7px 11px", fontFamily:"'Montserrat',sans-serif", fontSize:"10px", color:row.plc==="25"?"#C9A97A":"#a07de0" }}>{row.plc}</td>
                      <td style={{ padding:"7px 11px", fontFamily:"'Montserrat',sans-serif", fontSize:"10px", color:"#555", whiteSpace:"nowrap" }}>{row.category}</td>
                      <td style={{ padding:"7px 11px", fontFamily:"'Montserrat',sans-serif", fontSize:"11px", color:"#999" }}>{fmt(row.price)}</td>
                      <td style={{ padding:"7px 11px", fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:"#444" }}>{row.currency}</td>
                      <td style={{ padding:"7px 11px", fontFamily:"'Montserrat',sans-serif", fontSize:"11px", color:row.sfccPrice!==null?"#F0EBE0":"#333" }}>{fmt(row.sfccPrice)}</td>
                      <td style={{ padding:"7px 11px" }}>
                        <span style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"8px", letterSpacing:".05em", color:row.checkLevel==="Generic"?"#a07de0":"#5ab0f0" }}>{row.checkLevel}</span>
                      </td>
                      <td style={{ padding:"7px 11px" }}><StatusTag status={row.status} /></td>
                      <td style={{ padding:"7px 11px", fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:"#555", whiteSpace:"nowrap" }}>{row.detail||"—"}</td>
                    </tr>
                  ))}
                  {paged.length===0 && (
                    <tr><td colSpan={11} style={{ padding:"40px", textAlign:"center", fontFamily:"'Montserrat',sans-serif", fontSize:"10px", color:"#1a1a1a", letterSpacing:".2em", textTransform:"uppercase" }}>Aucun résultat</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {hasMore && (
              <div style={{ display:"flex", justifyContent:"center", marginTop:"12px" }}>
                <button className="fb" onClick={()=>setPage(p=>p+1)}>
                  Charger {Math.min(PAGE_SIZE,filtered.length-paged.length).toLocaleString()} lignes de plus ({(filtered.length-paged.length).toLocaleString()} restantes)
                </button>
              </div>
            )}

            <div style={{ fontFamily:"'Montserrat',sans-serif", fontSize:"9px", color:"#222", marginTop:"8px", display:"flex", justifyContent:"space-between", flexWrap:"wrap", gap:"6px" }}>
              <span>Check au {checkDateLabel} · Clic sur KPI ou Sales Org pour filtrer</span>
              <span><span style={{ color:"#a07de0" }}>■</span> Generic · <span style={{ color:"#5ab0f0" }}>■</span> SKU</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
