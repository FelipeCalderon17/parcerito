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

/** Minimal Linear GraphQL client, authenticated with the personal API key. */
export class LinearClient {
  constructor(
    private readonly apiKey: string,
    private readonly teamKey: string,
  ) {}

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch("https://api.linear.app/graphql", {
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

    const issueFields = "identifier title url description state { name }";
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
    const data = await this.gql<{ issueCreate: { issue: RawIssue } }>(
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
    );
    return toLinked(data.issueCreate.issue);
  }

  async comment(identifier: string, body: string): Promise<void> {
    const issue = await this.gql<{ issue: { id: string } }>(`query ($id: String!) { issue(id: $id) { id } }`, {
      id: identifier,
    });
    await this.gql(`mutation ($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`, {
      input: { issueId: issue.issue.id, body },
    });
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
    await this.gql(`mutation ($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`, {
      id: data.issue.id,
      input: { stateId: todo.id, assigneeId: data.viewer.id, ...(data.issue.team.activeCycle ? { cycleId: data.issue.team.activeCycle.id } : {}) },
    });
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
      const created = await this.gql<{ issueLabelCreate: { issueLabel: { id: string } } }>(
        `mutation ($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { issueLabel { id } } }`,
        { input: { name: LABEL_NAME, teamId, color: "#f2c94c" } },
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
