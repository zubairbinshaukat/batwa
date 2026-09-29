// Reports → Get data sheet: range presets, formats, copy / save / share.

import { el, buzz, segmented } from "../util/dom.js";
import { state } from "../ledger.js";
import { isoDate, thisMonth } from "../util/format.js";
import {
  buildReport,
  defaultRangeForMonth,
  formatRangeLabel,
  rangeForPreset,
  renderCsvReport,
  renderTextReport,
  renderXlsxReport,
  reportFilename,
  normalizeRange,
} from "../report-export.js";
import { downloadBlob } from "../util/download.js";
import { openSheet, onSheetClosed, toggleRow } from "./sheet.js";
import { accountName } from "./accounts.js";
import { toast } from "./toast.js";
import { icon } from "./icons.js";

const PRESETS = [
  { id: "this_month", label: "This month" },
  { id: "last_7", label: "Last 7 days" },
  { id: "last_30", label: "Last 30 days" },
  { id: "last_month", label: "Last month" },
  { id: "custom", label: "Custom" },
];

/** Lazy-load the vendored ExcelJS browser bundle once. */
let exceljsPromise = null;
function loadExcelJS() {
  if (typeof window !== "undefined" && window.ExcelJS) {
    return Promise.resolve(window.ExcelJS);
  }
  if (exceljsPromise) return exceljsPromise;
  exceljsPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-batwa-exceljs]');
    if (existing) {
      existing.addEventListener("load", () => resolve(window.ExcelJS));
      existing.addEventListener("error", () => reject(new Error("Couldn't load Excel")));
      return;
    }
    const s = document.createElement("script");
    s.src = "js/vendor/exceljs.min.js";
    s.async = true;
    s.dataset.batwaExceljs = "1";
    s.onload = () => {
      if (window.ExcelJS) resolve(window.ExcelJS);
      else reject(new Error("Couldn't load Excel"));
    };
    s.onerror = () => {
      exceljsPromise = null;
      reject(new Error("Couldn't load Excel"));
    };
    document.head.appendChild(s);
  });
  return exceljsPromise;
}

/**
 * Open the Get data sheet. `viewedMonth` is the Reports month navigator value
 * ("YYYY-MM") — it seeds the default range but presets never change the nav.
 */
export function openGetDataSheet(viewedMonth = thisMonth()) {
  const today = isoDate();
  const initial = defaultRangeForMonth(viewedMonth, today);
  const initialPreset = viewedMonth === thisMonth() ? "this_month" : "custom";

  let preset = initialPreset;
  let from = initial.from;
  let to = initial.to;
  let includeAdjustments = true;
  let format = "text"; // text | csv | excel
  let preparedFile = null; // File for the current excel/csv snapshot
  let preparedKey = "";
  let busy = false;

  openSheet("Get data", (body) => {
    const status = el("p", { class: "small muted", id: "gd-status" }, "");
    const errLine = el("p", { class: "small", id: "gd-error",
      style: "color:var(--c-neg);display:none;margin:0 0 8px" }, "");

    const fromInput = el("input", {
      class: "input", type: "date", value: from, id: "gd-from", "aria-label": "From date",
    });
    const toInput = el("input", {
      class: "input", type: "date", value: to, id: "gd-to", max: today, "aria-label": "To date",
    });

    const chipRow = el("div", { class: "filter-row", role: "group", "aria-label": "Quick ranges" });
    const chipBtns = new Map();
    for (const p of PRESETS) {
      const b = el("button", {
        type: "button",
        class: `filter-chip${p.id === preset ? " is-active" : ""}`,
        "aria-pressed": String(p.id === preset),
        onclick: () => {
          preset = p.id;
          for (const [id, btn] of chipBtns) {
            const on = id === preset;
            btn.classList.toggle("is-active", on);
            btn.setAttribute("aria-pressed", String(on));
          }
          if (preset !== "custom") {
            const r = rangeForPreset(preset, { today });
            from = r.from;
            to = r.to;
            fromInput.value = from;
            toInput.value = to;
          }
          preparedFile = null;
          refresh();
          buzz(6);
        },
      }, p.label);
      chipBtns.set(p.id, b);
      chipRow.append(b);
    }

    const markCustom = () => {
      if (preset === "custom") return;
      preset = "custom";
      for (const [id, btn] of chipBtns) {
        const on = id === "custom";
        btn.classList.toggle("is-active", on);
        btn.setAttribute("aria-pressed", String(on));
      }
    };

    fromInput.addEventListener("change", () => {
      from = fromInput.value;
      markCustom();
      preparedFile = null;
      refresh();
    });
    toInput.addEventListener("change", () => {
      to = toInput.value;
      markCustom();
      preparedFile = null;
      refresh();
    });

    const dates = el("div", { class: "gd-dates" },
      el("div", { class: "field", style: "margin-bottom:0;flex:1" },
        el("label", { for: "gd-from" }, "From"), fromInput),
      el("div", { class: "field", style: "margin-bottom:0;flex:1" },
        el("label", { for: "gd-to" }, "To"), toInput),
    );

    const adjToggle = toggleRow("Include adjustments", includeAdjustments, (on) => {
      includeAdjustments = on;
      preparedFile = null;
      refresh();
    });
    const adjHint = el("p", { class: "xsmall muted", style: "margin:6px 0 0" },
      "Off leaves starting balances and balance fixes out of the report.");

    const formatSeg = segmented(
      [
        { value: "text", label: "Text" },
        { value: "csv", label: "CSV" },
        { value: "excel", label: "Excel" },
      ],
      format,
      (v) => {
        format = v;
        preparedFile = null;
        refresh();
      },
    );

    const actions = el("div", { class: "form-actions gd-actions", style: "flex-wrap:wrap" });

    body.append(
      el("p", { class: "small muted", style: "margin:0 0 10px" },
        "Share a period of paid income and expenses. This is a flow report — not account balances."),
      chipRow,
      dates,
      el("div", { class: "field", style: "margin-top:14px;margin-bottom:8px" }, adjToggle, adjHint),
      el("div", { class: "field", style: "margin-bottom:8px" },
        el("label", {}, "Format"), formatSeg),
      status,
      errLine,
      actions,
      el("p", { class: "xsmall muted", style: "margin-top:12px" },
        "Shared files leave Batwa’s encryption. Only send them to people you trust."),
    );

    function currentReport() {
      return buildReport(state.entries, {
        from,
        to,
        includeAdjustments,
        accountNameOf: (id) => accountName(id) || "",
      });
    }

    function setError(msg) {
      if (!msg) {
        errLine.style.display = "none";
        errLine.textContent = "";
        return;
      }
      errLine.textContent = msg;
      errLine.style.display = "block";
    }

    function refresh() {
      const norm = normalizeRange(from, to, today);
      from = norm.from;
      to = norm.to;
      if (fromInput.value !== from) fromInput.value = from;
      if (toInput.value !== to) toInput.value = to;

      const report = currentReport();
      if (!norm.ok) {
        setError(norm.error);
        status.textContent = "";
        rebuildActions(null);
        return;
      }
      setError(null);
      const label = formatRangeLabel(report.from, report.to);
      status.textContent = report.transactions
        ? `${report.transactions} entr${report.transactions === 1 ? "y" : "ies"} · ${label}`
        : `No entries · ${label}`;
      rebuildActions(report);
    }

    function rebuildActions(report) {
      actions.innerHTML = "";
      const disabled = !report || !report.transactions || busy;

      if (format === "text") {
        actions.append(actionBtn("copy", "Copy", disabled, () => copyText(report)));
        if (canShareText()) {
          actions.append(actionBtn("share", "Share", disabled, () => shareText(report)));
        }
        actions.append(actionBtn("download", "Save", disabled, () => saveText(report)));
        return;
      }

      if (format === "csv") {
        actions.append(actionBtn("download", "Save", disabled, () => saveCsv(report)));
        // File share needs a prepared File; offer Share when likely supported.
        if (canShareSomething()) {
          actions.append(actionBtn("share", "Share", disabled, () => shareCsv(report)));
        }
        return;
      }

      // Excel: Save always; Share prepares then shares on a fresh tap when possible.
      actions.append(actionBtn("download", busy ? "Preparing…" : "Save", disabled, () => saveExcel(report)));
      if (canShareSomething()) {
        const shareLabel = preparedFile && preparedKey === fileKey(report, "xlsx")
          ? "Share"
          : "Prepare & share";
        actions.append(actionBtn("share", busy ? "Preparing…" : shareLabel, disabled, () => shareExcel(report)));
      }
    }

    function actionBtn(ico, label, disabled, onClick) {
      return el("button", {
        type: "button",
        class: "btn btn-primary",
        style: "flex:1;min-width:120px",
        disabled: disabled ? "" : undefined,
        html: `${icon(ico, 16)} ${label}`,
        onclick: onClick,
      });
    }

    async function copyText(report) {
      const text = renderTextReport(report);
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
        else throw new Error("no-clipboard");
        toast("Report copied", { icon: icon("check-circle", 18) });
      } catch {
        // Fallback: select a temporary textarea
        const ta = el("textarea", { style: "position:fixed;left:-9999px;top:0" }, text);
        document.body.append(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand && document.execCommand("copy"); } catch {}
        ta.remove();
        toast(ok ? "Report copied" : "Couldn't copy — try Share or Save", {
          icon: icon(ok ? "check-circle" : "alert", 18),
        });
      }
    }

    async function shareText(report) {
      const text = renderTextReport(report);
      try {
        await navigator.share({
          title: "Batwa expense report",
          text,
        });
      } catch (err) {
        if (err?.name === "AbortError") return;
        toast("Couldn't share — try Copy instead", { icon: icon("alert", 18) });
      }
    }

    function saveText(report) {
      const text = renderTextReport(report);
      downloadBlob(text, reportFilename(report, "txt"), "text/plain;charset=utf-8");
      toast("Text file saved", { icon: icon("download", 18) });
    }

    function saveCsv(report) {
      const csv = renderCsvReport(report);
      downloadBlob(csv, reportFilename(report, "csv"), "text/csv;charset=utf-8");
      toast("CSV saved", { icon: icon("download", 18) });
    }

    async function shareCsv(report) {
      const csv = renderCsvReport(report);
      const file = new File([csv], reportFilename(report, "csv"), {
        type: "text/csv",
      });
      await shareFile(file, "Batwa expense report");
    }

    async function ensureExcelFile(report) {
      const key = fileKey(report, "xlsx");
      if (preparedFile && preparedKey === key) return preparedFile;
      busy = true;
      rebuildActions(report);
      try {
        const ExcelJS = await loadExcelJS();
        preparedFile = await renderXlsxReport(report, ExcelJS);
        preparedKey = key;
        return preparedFile;
      } finally {
        busy = false;
        rebuildActions(currentReport());
      }
    }

    async function saveExcel(report) {
      try {
        const file = await ensureExcelFile(report);
        downloadBlob(file, file.name, file.type);
        toast("Excel saved", { icon: icon("download", 18) });
      } catch (err) {
        console.error(err);
        toast(err?.message || "Couldn't build Excel file", { icon: icon("alert", 18) });
      }
    }

    async function shareExcel(report) {
      try {
        // First tap may only prepare (activation can expire during workbook build).
        const key = fileKey(report, "xlsx");
        const already = preparedFile && preparedKey === key;
        const file = await ensureExcelFile(report);
        if (!already) {
          toast("Excel ready — tap Share again", { icon: icon("share", 18) });
          rebuildActions(report);
          return;
        }
        await shareFile(file, "Batwa expense report");
      } catch (err) {
        if (err?.name === "AbortError") return;
        console.error(err);
        toast(err?.message || "Couldn't share Excel — try Save", { icon: icon("alert", 18) });
      }
    }

    async function shareFile(file, title) {
      try {
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], title });
          return;
        }
      } catch (err) {
        if (err?.name === "AbortError") return;
        // fall through to download
      }
      downloadBlob(file, file.name, file.type);
      toast("Sharing unavailable — file saved instead", { icon: icon("download", 18) });
    }

    onSheetClosed(() => {
      preparedFile = null;
      preparedKey = "";
    });

    refresh();
  });
}

function fileKey(report, ext) {
  return [
    report.from,
    report.to,
    report.includeAdjustments ? "1" : "0",
    report.transactions,
    report.moneyIn,
    report.moneyOut,
    ext,
  ].join("|");
}

function canShareText() {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

function canShareSomething() {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}
