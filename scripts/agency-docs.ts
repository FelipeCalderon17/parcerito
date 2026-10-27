/**
 * Indexes Megan's agency documentation preferences for the review hub's issue classifier (see src/review/agency.ts).
 * Reads every .docx/.pdf in `AGENCY_DOCS_DIR` (default ~/Desktop/Lime/agency-docs), splits each into headed sections
 * and writes `<dir>/index.json`. The docs are customer documents: they and the index never go in the repo.
 *
 *   npm run agency-docs
 *
 * .docx via `unzip -p` (macOS ships it); .pdf via scripts/extract-manual-text.py with pypdf (`PYPDF_PYTHON`, default
 * /tmp/oasis_venv/bin/python — `python3 -m venv /tmp/oasis_venv && /tmp/oasis_venv/bin/pip install pypdf`).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agencyDocsDir, type AgencyDoc, type AgencyIndex } from "../src/review/agency.js";
import { docxLines, pdfLines, sectionsOf, type DocLine } from "../src/review/agency-parse.js";

/**
 * File → agency / EHR / visit types, read from each doc's name and first page. Correct here when Megan says
 * otherwise. agency null = generic for its EHR.
 */
const DOCS: Record<string, Pick<AgencyDoc, "agency" | "ehr" | "visitTypes">> = {
  "axxess_pt_assessment_evaluation_with_reassessment_analysis.docx": { agency: null, ehr: "Axxess", visitTypes: ["pt", "evaluation", "reassessment"] },
  "axxess_pt_pta_regular_visit_agency_preferences.docx": { agency: null, ehr: "Axxess", visitTypes: ["pt", "pta", "visit"] },
  "axxess_pta_supervisory_visit_agency_preferences.docx": { agency: null, ehr: "Axxess", visitTypes: ["pta", "supervisory", "visit"] },
  "axxess_skilled_nursing_visit_agency_preferences.docx": { agency: null, ehr: "Axxess", visitTypes: ["sn", "visit"] },
  // The doc doesn't name its EHR.
  "Mission_Home_Health_Axxess_SOC_Preferences.pdf": { agency: "Mission Home Health", ehr: "Axxess", visitTypes: ["soc"] },
  // The agency is named in the doc's defaults column.
  "Netsmart_SOC_Skilled_Nursing_Agency_Default_Preferences.pdf": { agency: "Care Dimensions", ehr: "Netsmart", visitTypes: ["soc", "sn"] },
  "New_Life_KanTime_SOC_Preferences.pdf": { agency: "New Life Home Health", ehr: "KanTime", visitTypes: ["soc"] },
};

const EXTRACT = path.join(path.dirname(fileURLToPath(import.meta.url)), "extract-manual-text.py");

/** A doc's lines: .docx from word/document.xml, .pdf through pypdf into a temp file (removed after). */
function linesOf(file: string): DocLine[] {
  if (file.endsWith(".docx")) return docxLines(execFileSync("unzip", ["-p", file, "word/document.xml"], { maxBuffer: 64 << 20 }).toString("utf8"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agency-doc-"));
  try {
    const out = path.join(tmp, "doc.txt");
    execFileSync(process.env.PYPDF_PYTHON || "/tmp/oasis_venv/bin/python", ["-I", EXTRACT, file, out], { stdio: ["ignore", "ignore", "inherit"] });
    return pdfLines(fs.readFileSync(out, "utf8"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  const dir = agencyDocsDir();
  const files = fs.readdirSync(dir).filter((f) => /\.(docx|pdf)$/i.test(f)).sort();
  const docs: AgencyDoc[] = files.map((file) => {
    const meta = DOCS[file] ?? { agency: null, ehr: null, visitTypes: [] };
    if (!DOCS[file]) console.warn(`${file}: not in the DOCS table — add its agency/EHR/visit types`);
    return { file, ...meta, ...sectionsOf(linesOf(path.join(dir, file))) };
  });
  const index: AgencyIndex = { builtAt: new Date().toISOString(), docs };
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(index, null, 2));
  for (const d of docs)
    console.log(`${d.file}\n  agency ${d.agency ?? `(generic ${d.ehr})`} · ehr ${d.ehr ?? "?"} · ${d.visitTypes.join("/")} · ${d.sections.length} sections, ${d.sections.reduce((n, s) => n + s.codes.length, 0)} codes`);
  console.log(`\n→ ${path.join(dir, "index.json")}`);
}

main();
