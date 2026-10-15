/**
 * Exports the AI suggestions that coders rejected or overwrote in Lime production and uploads them to your DM
 * with the bot, where the daily agenda picks them up. Runs on your machine: production is only reachable through
 * your AWS SSO login and an SSM tunnel.
 *
 *   npm run rejected-fields            # last 7 days (the agenda keeps only its own window)
 *   npm run rejected-fields -- --days 14
 */
import { execFile, spawn } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import { WebClient } from "@slack/web-api";

const run = promisify(execFile);
const PROFILE = "limeai-data";
const REGION = "us-east-1";
const LOCAL_PORT = 15432;
const DB_HOST = "production-database-postgresql.c0lsqwy6kuu3.us-east-1.rds.amazonaws.com";
const SECRET_ID = "limeai/production/db-readonly/felipe";
const PSQL = process.env.PSQL ?? "/opt/homebrew/opt/libpq/bin/psql";
const env = { ...process.env, AWS_PROFILE: PROFILE, AWS_REGION: REGION };

const daysArg = process.argv.indexOf("--days");
const days = daysArg > 0 ? Number(process.argv[daysArg + 1]) : 7;
if (!Number.isInteger(days) || days < 1) throw new Error("--days must be a positive integer");

// Rejected on review (with the coder's reason), or overwritten by a coder. Lime's own automatic rejections
// ('outdated', 'entity_removed') aren't feedback on the AI, so they're left out.
const SQL = `
select coalesce(json_agg(x order by x.decided_at desc), '[]') from (
  select r.id, r.decided_at, o.name as organization, f.name as form, fd.key as field_key, fd.label as field_label,
    fd.section, r.rejected_via, r.rejection_reason as reason, r.value as ai_value,
    (select a.value from answer a
      where a.task_id = r.task_id and a.form_field_id = r.form_field_id and a.created_at >= r.created_at
        and a.source = 'clinician'
      order by a.created_at desc limit 1) as coder_value
  from ai_recommendation r
  join task t on t.id = r.task_id
  left join clinician c on c.id = t.clinician_id
  left join organization o on o.id = c.organization_id
  join form_field ff on ff.id = r.form_field_id
  join field fd on fd.id = ff.field_id
  join form f on f.id = ff.form_id
  where r.decision = 'rejected'
    and (r.rejected_via = 'review' or r.rejection_reason not in ('outdated', 'entity_removed'))
    and r.decided_at > now() - interval '${days} days'
) x`;

async function main() {
  const token = process.env.SLACK_BOT_TOKEN;
  const recipient = process.env.AGENDA_RECIPIENT_ID ?? process.env.ALLOWED_SLACK_USER_IDS?.split(",")[0]?.trim();
  if (!token || !recipient) throw new Error("Set SLACK_BOT_TOKEN and ALLOWED_SLACK_USER_IDS in .env");

  await ensureLoggedIn();
  const closeTunnel = await openTunnel();
  let rows: unknown[];
  try {
    const { stdout: secret } = await run(
      "aws",
      ["secretsmanager", "get-secret-value", "--secret-id", SECRET_ID, "--query", "SecretString", "--output", "text"],
      { env },
    );
    const { stdout } = await run(
      PSQL,
      [
        `host=localhost port=${LOCAL_PORT} dbname=prod_db user=felipe_readonly sslmode=require`,
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        SQL,
      ],
      { env: { ...env, PGPASSWORD: JSON.parse(secret).password }, maxBuffer: 64 * 1024 * 1024 },
    );
    rows = JSON.parse(stdout);
  } finally {
    closeTunnel();
  }

  const exportedAt = new Date().toISOString();
  const slack = new WebClient(token);
  const dm = await slack.conversations.open({ users: recipient });
  await slack.files.uploadV2({
    channel_id: dm.channel!.id!,
    filename: `rejected-fields-${exportedAt.slice(0, 10)}.json`,
    title: "Rejected AI suggestions (prod export)",
    content: JSON.stringify({ exportedAt, days, rows }),
    initial_comment: `🗂️ Exported ${rows.length} rejected AI suggestion${rows.length === 1 ? "" : "s"} from the last ${days} days. The next agenda will include them.`,
  });
  console.log(`Uploaded ${rows.length} rows to your DM with the bot.`);
}

async function ensureLoggedIn() {
  try {
    await run("aws", ["sts", "get-caller-identity"], { env });
  } catch {
    console.log("AWS session expired, opening the SSO login in your browser…");
    await new Promise<void>((resolve, reject) => {
      spawn("aws", ["sso", "login", "--profile", PROFILE], { env, stdio: "inherit" }).on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error("aws sso login failed")),
      );
    });
  }
}

/** Opens the SSM port-forward, unless one is already listening. Returns a function that closes it. */
async function openTunnel(): Promise<() => void> {
  if (await portOpen(LOCAL_PORT)) return () => {};
  const { stdout } = await run(
    "aws",
    [
      "ec2",
      "describe-instances",
      "--filters",
      "Name=tag:Role,Values=db-tunnel",
      "Name=instance-state-name,Values=running",
      "--query",
      "Reservations[0].Instances[0].InstanceId",
      "--output",
      "text",
    ],
    { env },
  );
  const tunnel = spawn(
    "aws",
    [
      "ssm",
      "start-session",
      "--target",
      stdout.trim(),
      "--document-name",
      "AWS-StartPortForwardingSessionToRemoteHost",
      "--parameters",
      JSON.stringify({ host: [DB_HOST], portNumber: ["5432"], localPortNumber: [String(LOCAL_PORT)] }),
    ],
    { env },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The database tunnel didn't open within 60s")), 60_000);
    tunnel.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("Waiting for connections")) {
        clearTimeout(timer);
        resolve();
      }
    });
    tunnel.on("exit", (code) => reject(new Error(`The database tunnel exited (${code})`)));
  });
  return () => tunnel.kill();
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
