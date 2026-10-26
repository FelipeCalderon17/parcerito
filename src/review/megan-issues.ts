/** The issues reviewed with Megan: CMS manual verdict, questions and the SQL predicate picking each issue's fields. */
import type { Issue, Item, LinearIssue } from "./types.js";

const label = (...words: string[]) => `(${words.map((w) => `fd.label ilike '%${w}%'`).join(" or ")})`;

export const ISSUES: Issue[] = [
  {
    id: "ENG-3540",
    group: 1,
    verdict: "partial",
    manual:
      "M1840 (p.126–127): toilet → bedside commode → bedpan path. Code 3 = can't get to toilet/commode but places/removes bedpan independently; Code 4 = can't use commode or bedpan, or equipment isn't in the home. Excludes hygiene/clothing (M1845). Dash not valid.",
    ask: ["Apply the 'pick the more severe option' rule here (bedbound, no bedpan detail → 4)?", "Expected value for the Oct 22 source?"],
    fields: "fd.key ~ '^M1840'",
    related: ["ENG-3504", "ENG-3522", "ENG-3523"],
  },
  {
    id: "ENG-3523",
    group: 1,
    verdict: "partial",
    manual:
      "M1830 (p.125–126): whole-body bathing incl. tub/shower transfer; excludes face/hands/hair. 4/5/6 when no or unsafe tub/shower. Code 6 = totally bathed by another person regardless of where. Dash not valid.",
    ask: ["Gene's expected value for the Oct 21 and Oct 22 sources?"],
    fields: "fd.key ~ '^M1830'",
    related: ["ENG-3504", "ENG-3522", "ENG-3540"],
  },
  {
    id: "ENG-3522",
    group: 1,
    verdict: "partial",
    manual:
      "M1810/M1820 (p.123–125): Code 3 only when dependent on another person for the majority of dressing tasks, otherwise 2. Devices (sling, collar, AFO, prosthesis, TED hose) count. Majority of tasks, weighted by frequency (p.15).",
    ask: ["Expected values for M1810 and M1820 separately?", "Was Gene looking at an older saved answer or the latest pending suggestion?"],
    fields: "fd.key ~ '^M18[12]0'",
    related: ["ENG-3504", "ENG-3523", "ENG-3540"],
  },
  {
    id: "ENG-3531",
    group: 3,
    verdict: "partial",
    manual:
      "M1033 (p.181–183): option 7 = 5+ meds on the reconciled med profile (incl. OTC, vitamins, herbals, oxygen). Option 8 (exhaustion): no specific guidance, current patient report. Record/referral are valid sources.",
    ask: ["Does 'tired' / 'fatigue' count as exhaustion (option 8)?", "Confirm option 7 should be computed from the med list."],
    fields: "fd.key ~ '^M1033'",
    related: ["ENG-3505"],
  },
  {
    id: "ENG-3529",
    group: 2,
    verdict: "partial",
    manual:
      "GG0170 (p.144–148, 167–168): patient/caregiver report is enough to code. 07/09/10/88 only with a reason; dash rare. Q1 = 0 is the only case that skips the wheelchair items. Lime leaves Q1 blank → R1/RR1/S1/SS1 hidden (bug).",
    ask: ["Were the 16 abstentions justified by the transcript?", "How do the CareDimensions doc limits on activity-not-attempted codes fit p.144/147?"],
    fields: "fd.key ~ '^GG0170'",
    related: ["ENG-3527", "ENG-3539"],
  },
  {
    id: "ENG-3533",
    group: 4,
    verdict: "not-in-manual",
    manual: "Safety measures are a Plan of Care (485) / Axxess field, not OASIS. Only general rule: assessment and POC must be congruent (p.8).",
    ask: [
      "What evidence justifies each safety-measure box?",
      "Bleeding precautions: is an anticoagulant on the med list / a bleeding-risk diagnosis enough, or is explicit teaching/order required?",
    ],
    fields: label("safety", "bleeding", "sharps", "nail care", "electrical"),
  },
  {
    id: "ENG-3532",
    group: 4,
    verdict: "not-in-manual",
    manual: "Venipuncture / Blood test obtained is an Axxess Summary of Care field, not OASIS. The AI seems to have used fingerstick/vitals readings as a blood draw.",
    ask: ["Check it only when a blood draw during the visit is explicitly documented (never from glucometer readings)?"],
    fields: label("venipuncture", "blood test", "blood draw", "needle", "attempt"),
  },
  {
    id: "ENG-3526",
    group: 4,
    verdict: "not-in-manual",
    manual: "Netsmart 'Additional details' boxes are EHR free text, not OASIS. Product/agency decision.",
    ask: ["Suppress text that only repeats the coded answer, keep supported qualifiers and clinician text. Agree? Which forms?"],
    fields: `(${label("additional detail", "additional info")} or fd.key ~ '^(M1060|C0200)')`,
  },
  {
    id: "ENG-3464",
    group: 5,
    verdict: "not-in-manual",
    manual: "Homebound isn't OASIS data (p.5, p.10–11). Narrative criteria live in the Medicare Benefit Policy Manual Ch. 7 §30.1.1 (taxing effort, devices/assistance needed, frequency/reason for absences).",
    ask: ["Approve wording: include functional context only when the source supports it, never infer deficits, flag gaps?"],
    fields: label("homebound"),
  },
  {
    id: "ENG-3486",
    group: 3,
    verdict: "not-in-manual",
    manual: "Transcription accuracy is a vendor check (AssemblyAI). Manual: interpreter answers are patient answers (p.51), A1110A/B (p.39–40), BIMS equivalent words (p.84).",
    ask: ["Which non-English visits were wrong and how (transcript vs form fill)?"],
    fields: `(fd.key ~ '^A1110' or ${label("language", "interpreter")})`,
  },
  {
    id: "ENG-3515",
    group: 5,
    verdict: "not-in-manual",
    manual: "The SOC summary/narrative isn't OASIS; governed by CoPs (42 CFR 484). It must not claim actions that weren't done (Conv. 9, M0090 attestation).",
    ask: ["Which approved summary template does Universal expect per discipline/timepoint?"],
    fields: label("summary", "narrative"),
  },
  {
    id: "ENG-3503",
    group: 5,
    verdict: "not-in-manual",
    manual: "No OASIS item covers a care-coordination narrative. Collaboration allowed per agency policy (Conv. 17, p.14); documentation must reflect what was done (p.42).",
    ask: ["Add the sentence only when the recording supports it, or as a template the clinician must confirm?"],
    fields: label("coordinat", "summary", "narrative"),
  },
  {
    id: "ENG-3534",
    group: 4,
    verdict: "not-in-manual",
    manual: "PT goals/interventions aren't OASIS items (M2401 is Transfer/DC only, p.251). Clinician owns responses (Conv. 9).",
    ask: ["Confirm the exact page-11 fields to leave blank for Absolute PT SOC."],
    fields: label("goal", "intervention", "treatment plan"),
  },
  {
    id: "ENG-3535",
    group: 4,
    verdict: "not-in-manual",
    manual: "LRI = Legally Responsible Individual, a Medicaid/HCBS concept on the Kantime form. Not in the OASIS manual (closest: M2102 caregiver ability, p.120–121).",
    ask: ["Ericka/HaH policy: minors only, or spouses too? Field ID?"],
    fields: label("LRI", "legally responsible"),
  },
  {
    id: "ENG-3472",
    group: 5,
    verdict: "not-in-manual",
    manual: "An SN routine visit isn't an OASIS timepoint. Only partial support: continuous O2 = ≥14 h/day (O0110C, p.245–246); >50% of the time rule (Conv. 4).",
    ask: ["Interventions workflow?", "Confirm the 'Agency to confirm' defaults for Astra."],
    fields: label("narrative", "vital", "oxygen", "no problem", "intervention"),
    related: ["ENG-3471", "ENG-3482"],
  },
];

/** A Megan issue as a review item; the title and status line come from its Linear issue when it loaded. */
export function meganItem(issue: Issue, linear?: LinearIssue): Item {
  return {
    id: issue.id,
    title: linear?.title ?? issue.id,
    origin: { kind: "megan" },
    group: issue.group,
    linear: [issue.id],
    slack: [],
    fields: issue.fields,
    badges: [issue.verdict === "partial" ? { text: "Manual: partial", kind: "warn" } : { text: "Not in manual", kind: "bad" }],
    meta: [
      ...(linear ? [linear.state.name, linear.assignee?.name ?? "unassigned"] : []),
      ...(issue.related ? [`related ${issue.related.join(", ")}`] : []),
    ],
    panel: {
      blocks: [{ cls: "manual", title: "📘 CMS OASIS-E2 manual", text: issue.manual }],
      questions: { title: "❓ Questions for Megan", items: issue.ask },
      placeholder: "Megan's answer, rule to apply, owner…",
    },
    text: "",
    verdict: issue.verdict,
  };
}
