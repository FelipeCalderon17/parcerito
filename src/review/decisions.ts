/**
 * After a review meeting: turns the decisions saved in the Lime coder-feedback dashboard into Linear updates, in
 * one batch. Approved answers get a comment and move the issue to Todo in the current cycle; answers saved while the
 * issue still needs clarification get a comment with what was answered and what is still open. Each decision version
 * is synced once (tracked in DATA_DIR).
 */
import fs from "node:fs";
import path from "node:path";
import type { ApprovedDecision } from "./publish.js";

export type DecisionAction = "comment-and-todo" | "comment";

export interface DecisionUpdate {
  key: string;
  decision: ApprovedDecision;
  issues: string[];
  action: DecisionAction;
  comment: string;
}

const LABELS: Record<string, string> = {
  approved: "Approved for engineering",
  implemented: "Implemented",
  verified: "Verified",
  "needs-clarification": "Still needs clarification",
};

/** A decision version's sync key: a new version (an edited answer) syncs again. */
export const decisionKey = (d: Pick<ApprovedDecision, "id" | "version">) => `${d.id}#v${d.version}`;

/** Only approved answers move the issue; implemented/verified already happened, open ones stay where they are. */
export function actionFor(status: string): DecisionAction {
  return status === "approved" ? "comment-and-todo" : "comment";
}

/** The Linear comment: status, scope, the questions that were on the table, and the answer as written. */
export function decisionComment(d: ApprovedDecision, questions: string[]): string {
  return [
    `**Clinical review decision: ${LABELS[d.status] ?? d.status}**`,
    `Scope: ${d.scope}`,
    questions.length ? `**Questions to resolve**\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}` : "",
    `**Answer**\n${d.answer}`,
    `_Recorded by ${d.authorName} on ${d.createdAt.slice(0, 10)} in the Lime coder-feedback dashboard; synced by parcerito._`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The updates to propose: every saved decision not synced yet. Decisions without a Linear issue (agenda items that
 * never got one) are returned separately so they can be listed instead of silently dropped.
 */
export function planUpdates(
  decisions: ApprovedDecision[],
  synced: Set<string>,
  questionsFor: (id: string) => string[],
): { updates: DecisionUpdate[]; withoutIssue: ApprovedDecision[] } {
  const fresh = decisions.filter((d) => !synced.has(decisionKey(d)));
  return {
    updates: fresh
      .filter((d) => d.linearIds.length)
      .map((d) => ({
        key: decisionKey(d),
        decision: d,
        issues: d.linearIds,
        action: actionFor(d.status),
        comment: decisionComment(d, questionsFor(d.id)),
      })),
    withoutIssue: fresh.filter((d) => !d.linearIds.length),
  };
}

/** The synced decision versions, kept in DATA_DIR so a decision is posted to Linear once. */
export function loadSynced(dataDir: string): Set<string> {
  const file = path.join(dataDir, "review-decisions-synced.json");
  return new Set(fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as string[]) : []);
}

export function saveSynced(dataDir: string, synced: Set<string>): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "review-decisions-synced.json");
  fs.writeFileSync(`${file}.tmp`, JSON.stringify([...synced], null, 2));
  fs.renameSync(`${file}.tmp`, file);
}
