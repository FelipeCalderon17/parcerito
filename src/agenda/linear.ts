import { createHash } from "node:crypto";
import type { Conversation } from "./collect.js";

export interface LinkedIssue {
  identifier: string;
  title: string;
  url: string;
  state: string;
  /** Linear's state category: triage, backlog, unstarted, started, completed, canceled. */
  stateType?: string;
}

const LABEL_NAME = "parcerito";
// Slack message timestamps as Dotterino writes them ("1792084072.359189") or as they appear in permalinks ("p1792084072359189").
const SLACK_TS = /\b(\d{10})\.(\d{6})\b|\bp(\d{10})(\d{6})\b/g;

/** Write mode of a LinearClient: `dryRun` logs each mutation (name + variables) instead of sending it. */
export interface LinearOptions {
  dryRun?: boolean;
  /** Where dry-run mutations are reported (default console.log). */
  log?: (line: string) => void;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

/** `LINEAR_DRY_RUN=1` (or `true`) makes every LinearClient a dry run, whatever the caller asked. */
export const envDryRun = (env = process.env) => /^(1|true|yes)$/i.test(env.LINEAR_DRY_RUN ?? "");

/** Minimal Linear GraphQL client, authenticated with the personal API key. */
export class LinearClient {
  readonly dryRun: boolean;
  private readonly log: (line: string) => void;
  private readonly fetchFn: typeof fetch;
  private fakeIds = 0;

  constructor(
    private readonly apiKey: string,
    private readonly teamKey: string,
    options: LinearOptions = {},
  ) {
    this.dryRun = Boolean(options.dryRun) || envDryRun();
    this.log = options.log ?? console.log;
    this.fetchFn = options.fetch ?? ((...args) => fetch(...args));
  }

  /**
   * Every write goes through here: a dry run reports the mutation and returns `fake` without calling Linear, so
   * dev/test runs never change anything.
   */
  private async mutate<T>(mutation: string, variables: Record<string, unknown>, fake: T): Promise<T> {
    if (!this.dryRun) return this.gql<T>(mutation, variables);
    const name = mutation.match(/\{\s*(\w+)\s*\(/)?.[1] ?? "mutation";
    this.log(`[linear dry-run] ${name} ${JSON.stringify(variables)}`);
    return fake;
  }

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    // Guard: a dry run must never send a mutation, even from a code path that forgot mutate().
    if (this.dryRun && /^\s*mutation\b/.test(query)) throw new Error("Linear dry run: refusing to send a mutation");
    const res = await this.fetchFn("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: this.apiKey },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (!res.ok || body.errors?.length) {
      throw new Error(`Linear: ${body.errors?.map((e) => e.message).join("; ") ?? res.statusText}`);
    }
    return body.data!;
  }

  /**
   * Which Slack messages are already tracked. Dotterino (and we) cite the source message's timestamp in the
   * issue description or a comment, so we map every timestamp cited since `since` to its issues, in any team.
   */
  async trackedSlackMessages(since: Date): Promise<Map<string, LinkedIssue[]>> {
    const tracked = new Map<string, LinkedIssue[]>();
    const add = (text: string | null | undefined, issue: RawIssue) => {
      for (const ts of slackTimestamps(text ?? "")) {
        const list = tracked.get(ts) ?? [];
        if (!list.some((i) => i.identifier === issue.identifier)) list.push(toLinked(issue));
        tracked.set(ts, list);
      }
    };

    const issueFields = "identifier title url description state { name type }";
    for await (const issue of this.paginate<RawIssue>(
      "issues",
      `issues(first: 100, after: $after, filter: { updatedAt: { gte: $since } }) {
        nodes { ${issueFields} } pageInfo { hasNextPage endCursor } }`,
      { since: since.toISOString() },
      "$since: DateTimeOrDuration!",
    )) {
      add(issue.description, issue);
    }
    for await (const comment of this.paginate<{ body: string; issue: RawIssue | null }>(
      "comments",
      `comments(first: 100, after: $after, filter: { createdAt: { gte: $since } }) {
        nodes { body issue { ${issueFields} } } pageInfo { hasNextPage endCursor } }`,
      { since: since.toISOString() },
      "$since: DateTimeOrDuration!",
    )) {
      if (comment.issue) add(comment.body, comment.issue);
    }
    return tracked;
  }

  private async *paginate<T>(field: string, selection: string, variables: Record<string, unknown>, params: string) {
    let after: string | null = null;
    do {
      const data: Record<string, { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string } }> =
        await this.gql(`query ($after: String, ${params}) { ${selection} }`, { ...variables, after });
      const page = data[field];
      yield* page.nodes;
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
  }

  async getIssue(identifier: string): Promise<LinkedIssue | null> {
    const data = await this.gql<{ issue: RawIssue | null }>(
      `query ($id: String!) { issue(id: $id) { identifier title url state { name type } } }`,
      { id: identifier },
    ).catch(() => ({ issue: null }));
    return data.issue ? toLinked(data.issue) : null;
  }

  /** Creates an issue in the team's Triage, labelled so it's clear parcerito filed it for Dotterino. */
  async createTriageIssue(title: string, description: string): Promise<LinkedIssue> {
    const { teamId, triageStateId } = await this.team();
    const labelId = await this.labelId(teamId);
    const fakeId = `DRY-RUN-${++this.fakeIds}`;
    const data = await this.mutate<{ issueCreate: { issue: RawIssue } }>(
      `mutation ($input: IssueCreateInput!) { issueCreate(input: $input) { issue { identifier title url state { name } } } }`,
      {
        input: {
          teamId,
          title,
          description,
          ...(triageStateId ? { stateId: triageStateId } : {}),
          ...(labelId ? { labelIds: [labelId] } : {}),
        },
      },
      { issueCreate: { issue: { identifier: fakeId, title, url: `https://linear.app/dry-run/${fakeId}`, state: { name: "Triage" } } } },
    );
    return toLinked(data.issueCreate.issue);
  }

  async comment(identifier: string, body: string): Promise<void> {
    const issue = await this.gql<{ issue: { id: string } }>(`query ($id: String!) { issue(id: $id) { id } }`, {
      id: identifier,
    });
    await this.mutate(
      `mutation ($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
      { input: { issueId: issue.issue.id, body } },
      { commentCreate: { success: true } },
    );
  }

  /**
   * Puts the `[Agenda - date]` prefix on an issue's title (see agendaTitle); no write when it's already there.
   * Returns the title it ends up with and whether it changed.
   */
  async ensureAgendaTitle(identifier: string, date: string): Promise<{ title: string; changed: boolean }> {
    const data = await this.gql<{ issue: { id: string; title: string; team: { key: string } } }>(
      `query ($id: String!) { issue(id: $id) { id title team { key } } }`,
      { id: identifier },
    );
    // Only our own team's issues get the agenda prefix; other teams' titles stay as their owners wrote them.
    if (data.issue.team.key !== this.teamKey) return { title: data.issue.title, changed: false };
    const title = agendaTitle(data.issue.title, date);
    if (title === data.issue.title) return { title, changed: false };
    await this.mutate(
      `mutation ($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
      { id: data.issue.id, input: { title } },
      { issueUpdate: { success: true } },
    );
    return { title, changed: true };
  }

  /**
   * Creates or updates in place the issue's one comment matching `isMine` (see isReviewComment); unchanged when
   * its body already carries the same `rev` (see withRevision).
   */
  async upsertComment(
    identifier: string,
    body: string,
    isMine: (body: string) => boolean,
    /** Leave an existing comment alone when this says so (e.g. Railway mustn't replace the local full review). */
    keep: (existing: string) => boolean = () => false,
  ): Promise<"created" | "updated" | "unchanged"> {
    const data = await this.gql<{ issue: { id: string; comments: { nodes: { id: string; body: string }[] } } }>(
      `query ($id: String!) { issue(id: $id) { id comments(first: 250) { nodes { id body } } } }`,
      { id: identifier },
    );
    const existing = data.issue.comments.nodes.find((c) => isMine(c.body));
    if (existing && (sameRevision(existing.body, body) || keep(existing.body))) return "unchanged";
    if (existing) {
      await this.mutate(
        `mutation ($id: String!, $input: CommentUpdateInput!) { commentUpdate(id: $id, input: $input) { success } }`,
        { id: existing.id, input: { body } },
        { commentUpdate: { success: true } },
      );
      return "updated";
    }
    await this.mutate(
      `mutation ($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
      { input: { issueId: data.issue.id, body } },
      { commentCreate: { success: true } },
    );
    return "created";
  }

  /**
   * Marks `newer` as a duplicate of `older`: the duplicate relation, the team's Duplicate state (when it has one)
   * and a comment saying why.
   */
  async markDuplicate(newer: string, older: string, comment: string): Promise<void> {
    const data = await this.gql<{
      a: { id: string; team: { states: { nodes: { id: string; name: string; type: string }[] } } };
      b: { id: string };
    }>(
      `query ($a: String!, $b: String!) { a: issue(id: $a) { id team { states { nodes { id name type } } } } b: issue(id: $b) { id } }`,
      { a: newer, b: older },
    );
    const states = data.a.team.states.nodes;
    const duplicate = states.find((s) => s.type === "duplicate") ?? states.find((s) => /duplicate/i.test(s.name));
    await this.mutate(
      `mutation ($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }`,
      { input: { issueId: data.a.id, relatedIssueId: data.b.id, type: "duplicate" } },
      { issueRelationCreate: { success: true } },
    );
    if (duplicate)
      await this.mutate(
        `mutation ($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
        { id: data.a.id, input: { stateId: duplicate.id } },
        { issueUpdate: { success: true } },
      );
    await this.mutate(
      `mutation ($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
      { input: { issueId: data.a.id, body: comment } },
      { commentCreate: { success: true } },
    );
  }

  /** Moves an issue to the team's Todo state, in the active cycle, assigned to the API key's owner. */
  async moveToTodo(identifier: string): Promise<void> {
    const data = await this.gql<{
      viewer: { id: string };
      issue: { id: string; team: { states: { nodes: { id: string; name: string; type: string }[] }; activeCycle: { id: string } | null } };
    }>(
      `query ($id: String!) { viewer { id } issue(id: $id) { id team { states { nodes { id name type } } activeCycle { id } } } }`,
      { id: identifier },
    );
    const states = data.issue.team.states.nodes;
    const todo = states.find((s) => s.name.toLowerCase() === "todo") ?? states.find((s) => s.type === "unstarted");
    if (!todo) throw new Error(`No Todo state on ${identifier}'s team`);
    await this.mutate(
      `mutation ($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
      {
        id: data.issue.id,
        input: { stateId: todo.id, assigneeId: data.viewer.id, ...(data.issue.team.activeCycle ? { cycleId: data.issue.team.activeCycle.id } : {}) },
      },
      { issueUpdate: { success: true } },
    );
  }

  private teamInfo?: Promise<{ teamId: string; triageStateId?: string }>;
  private team() {
    this.teamInfo ??= this.gql<{
      teams: { nodes: { id: string; states: { nodes: { id: string; type: string }[] } }[] };
    }>(
      `query ($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id states { nodes { id type } } } } }`,
      { key: this.teamKey },
    ).then((data) => {
      const team = data.teams.nodes[0];
      if (!team) throw new Error(`Linear team ${this.teamKey} not found`);
      return { teamId: team.id, triageStateId: team.states.nodes.find((s) => s.type === "triage")?.id };
    });
    return this.teamInfo;
  }

  private label?: Promise<string | undefined>;
  private labelId(teamId: string) {
    this.label ??= (async () => {
      const found = await this.gql<{ issueLabels: { nodes: { id: string }[] } }>(
        `query ($name: String!) { issueLabels(filter: { name: { eq: $name } }) { nodes { id } } }`,
        { name: LABEL_NAME },
      );
      if (found.issueLabels.nodes[0]) return found.issueLabels.nodes[0].id;
      const created = await this.mutate<{ issueLabelCreate: { issueLabel: { id: string } } }>(
        `mutation ($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { issueLabel { id } } }`,
        { input: { name: LABEL_NAME, teamId, color: "#f2c94c" } },
        { issueLabelCreate: { issueLabel: { id: "dry-run-label" } } },
      );
      return created.issueLabelCreate.issueLabel.id;
    })().catch((error) => {
      console.warn("Couldn't find or create the parcerito label", error);
      return undefined;
    });
    return this.label;
  }
}

interface RawIssue {
  identifier: string;
  title: string;
  url: string;
  description?: string | null;
  state?: { name: string; type?: string } | null;
}

function toLinked(issue: RawIssue): LinkedIssue {
  return {
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    state: issue.state?.name ?? "",
    ...(issue.state?.type ? { stateType: issue.state.type } : {}),
  };
}

/** Slack message timestamps cited in a Linear description or comment. */
export function slackTimestamps(text: string): string[] {
  return [...text.matchAll(SLACK_TS)].map((m) => (m[1] ? `${m[1]}.${m[2]}` : `${m[3]}.${m[4]}`));
}

/** Issues already citing any message of the conversation. */
export function issuesFor(conversation: Conversation, tracked: Map<string, LinkedIssue[]>): LinkedIssue[] {
  const found = new Map<string, LinkedIssue>();
  for (const ts of [conversation.rootTs, ...conversation.messages.map((m) => m.ts)]) {
    for (const issue of tracked.get(ts) ?? []) found.set(issue.identifier, issue);
  }
  return [...found.values()];
}

/** Same "Source checkpoint" convention Dotterino uses, so either bot recognizes the message as tracked. */
export function sourceFooter(conversations: Conversation[]): string {
  const lines = conversations.map(
    (c) => `- [#${c.channelName}](${c.url}) — Source checkpoint: channel ${c.channelId}; root/message ${c.rootTs}`,
  );
  return `## Source\n\n${lines.join("\n")}\n\nFiled by parcerito on Dotterino's behalf (the message wasn't tracked in Linear yet).`;
}

// ---------- Agenda titles & review comments ----------

const AGENDA_PREFIX = /^(?:\s*\[Agenda - (\d{4}-\d{2}-\d{2})\]\s*)+/;

/**
 * `[Agenda - date] title`: replaces any existing agenda prefix (never stacks them) and keeps a newer one, so an
 * older agenda can't move an issue back in time. Other brackets ("[Netsmart] …") stay as they are.
 */
export function agendaTitle(title: string, date: string): string {
  const match = title.match(AGENDA_PREFIX);
  const dates = match ? [...match[0].matchAll(/\d{4}-\d{2}-\d{2}/g)].map((m) => m[0]) : [];
  const keep = [date, ...dates].sort().at(-1)!;
  return `[Agenda - ${keep}] ${title.replace(AGENDA_PREFIX, "").trim()}`;
}

/** A title without its `[Agenda - date]` prefix. */
export const withoutAgendaPrefix = (title: string) => title.replace(AGENDA_PREFIX, "").trim();

/** The hidden marker of an issue's agenda review comment for one agenda date. */
export const reviewMarker = (date: string) => `<!-- parcerito:agenda-review:${date} -->`;
/** Its visible heading; also how the comment is found if Linear drops the HTML marker. */
export const reviewHeading = (date: string) => `## Agenda review — ${date}`;

/** Whether a comment body is the agenda review of `date` (by marker, or by heading on its first line). */
export function isReviewComment(body: string, date: string): boolean {
  if (body.includes(reviewMarker(date))) return true;
  const first = body.trimStart().split("\n")[0] ?? "";
  return first.replace(/^#+\s*/, "").replace(/\\/g, "").trim() === reviewHeading(date).replace(/^#+\s*/, "");
}

const REVISION = /parcerito rev ([0-9a-f]{8})/;

/** Appends `parcerito rev <hash>` (hash of the body), so an unchanged review isn't re-sent. */
export function withRevision(body: string): string {
  return `${body.trimEnd()}\n\n<sub>parcerito rev ${createHash("sha256").update(body.trimEnd()).digest("hex").slice(0, 8)}</sub>`;
}

/** Whether two bodies carry the same revision stamp. */
export function sameRevision(a: string, b: string): boolean {
  const ra = a.match(REVISION)?.[1];
  return Boolean(ra) && ra === b.match(REVISION)?.[1];
}
