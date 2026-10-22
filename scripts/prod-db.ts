/**
 * Read-only access to Lime production for the local scripts. Production is only reachable through your AWS SSO
 * login and an SSM tunnel, so these run on your machine, never on the bot.
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

/** Runs one SQL statement per call, as the read-only role and inside read-only transactions. */
export type Query = (sql: string) => Promise<string>;

/** Logs in, opens the tunnel, hands `work` a query function and closes the tunnel when it's done. */
export async function withProdDb<T>(work: (query: Query) => Promise<T>): Promise<T> {
  await ensureLoggedIn();
  const closeTunnel = await openTunnel();
  try {
    const { stdout: secret } = await run(
      "aws",
      ["secretsmanager", "get-secret-value", "--secret-id", SECRET_ID, "--query", "SecretString", "--output", "text"],
      { env },
    );
    const pgEnv = {
      ...env,
      PGPASSWORD: JSON.parse(secret).password,
      PGOPTIONS: "-c default_transaction_read_only=on",
    };
    return await work(async (sql) => {
      const { stdout } = await run(
        PSQL,
        [
          `host=localhost port=${LOCAL_PORT} dbname=prod_db user=felipe_readonly sslmode=require`,
          "-At",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          sql,
        ],
        { env: pgEnv, maxBuffer: 256 * 1024 * 1024 },
      );
      return stdout;
    });
  } finally {
    closeTunnel();
  }
}

/** Slack client plus the DM channel with the agenda recipient, where the bot picks up the exports. */
export async function openBotDm(): Promise<{ slack: WebClient; channel: string }> {
  const token = process.env.SLACK_BOT_TOKEN;
  const recipient = process.env.AGENDA_RECIPIENT_ID ?? process.env.ALLOWED_SLACK_USER_IDS?.split(",")[0]?.trim();
  if (!token || !recipient) throw new Error("Set SLACK_BOT_TOKEN and ALLOWED_SLACK_USER_IDS in .env");
  const slack = new WebClient(token);
  const dm = await slack.conversations.open({ users: recipient });
  return { slack, channel: dm.channel!.id! };
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
    // Own process group, so closing also stops the session-manager-plugin child that holds the port.
    { env, detached: true },
  );
  // Keep the CLI's error (e.g. TargetNotConnected when the bastion's SSM agent is down), the exit code alone says nothing.
  let stderr = "";
  tunnel.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The database tunnel didn't open within 60s")), 60_000);
    tunnel.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("Waiting for connections")) {
        clearTimeout(timer);
        resolve();
      }
    });
    tunnel.on("exit", (code) => reject(new Error(`The database tunnel exited (${code}): ${stderr.trim()}`)));
  });
  return () => {
    try {
      process.kill(-tunnel.pid!);
    } catch {
      // Already gone.
    }
  };
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
