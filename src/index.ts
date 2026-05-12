#!/usr/bin/env node

import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import YAML from "yaml";
import { spawn } from "node:child_process";

const CONFIG_FILE = "pongreay.config.yml";

interface PongreayEnvironment {
  server: string;
  branch: string;
  appName: string;
  imageName: string;
  envFileOnServer: string;
  hostPort: number;
  containerPort: number;
}


interface PongreayConfig {
  project: string;
  healthPath: string;
  environments: Record<string, PongreayEnvironment>;
}

interface DeployOptions {
  confirm?: boolean;
  dryRun?: boolean;
  skipTests?: boolean;
  noCache?: boolean;
  buildArg?: string[];
  timeout?: string;
  keepImages?: string;
}

const REQUIRED_DOCKERIGNORE_ENTRIES = [".env", ".env.*", "!.env.example"];
const DEFAULT_HEALTH_TIMEOUT_SECONDS = 30;
const DEFAULT_KEEP_IMAGES = 5;

function run(command: string, args: string[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: process.platform === "win32" && command === "npm",
    });

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed with code ${code}`));
    });
  });
}

function runShell(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      stdio: "inherit",
      shell: true,
    });

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed: ${command}`));
    });
  });
}

function output(command: string, args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32" && command === "npm",
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || `${command} failed`));
    });
  });
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat(value);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }

  return parsed;
}

function shellQuote(value: string | number): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function getEnvironment(
  config: PongreayConfig,
  environmentName: string,
): PongreayEnvironment {
  const env = config.environments[environmentName];

  if (!env) {
    throw new Error(`Unknown environment: ${environmentName}`);
  }

  return env;
}

function createDefaultConfig(hostname = "deploy", ip = "your-ip-address"): void {
  const config = `project: my-nestjs-api
healthPath: /health

environments:
  uat:
    server: ${hostname}@${ip}
    branch: develop
    appName: my-nestjs-api-uat
    imageName: my-nestjs-api
    envFileOnServer: /etc/pongreay/my-nestjs-api/uat.env
    hostPort: 3000
    containerPort: 3000

  production:
    server: ${hostname}@${ip}
    branch: main
    appName: my-nestjs-api
    imageName: my-nestjs-api
    envFileOnServer: /etc/pongreay/my-nestjs-api/production.env
    hostPort: 3000
    containerPort: 3000
`;

  if (fs.existsSync(CONFIG_FILE)) {
    console.log(`${CONFIG_FILE} already exists.`);
    return;
  }

  fs.writeFileSync(CONFIG_FILE, config, "utf8");
  console.log(`Created ${CONFIG_FILE}`);
  ensureDockerignore();
}

function loadConfig(): PongreayConfig {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(`Missing ${CONFIG_FILE}. Run: pongreay init`);
  }

  const rawConfig = fs.readFileSync(CONFIG_FILE, "utf8");
  const config = YAML.parse(rawConfig) as PongreayConfig;

  if (!config.project) throw new Error("Missing config: project");
  if (!config.healthPath) throw new Error("Missing config: healthPath");
  if (!config.environments) throw new Error("Missing config: environments");

  return config;
}

function ensureDockerignore(): void {
  const dockerignoreFile = ".dockerignore";
  const existingContent = fs.existsSync(dockerignoreFile)
    ? fs.readFileSync(dockerignoreFile, "utf8")
    : "";
  const existingEntries = new Set(
    existingContent
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );
  const missingEntries = REQUIRED_DOCKERIGNORE_ENTRIES.filter(
    (entry) => !existingEntries.has(entry),
  );

  if (missingEntries.length === 0) return;

  const prefix = existingContent && !existingContent.endsWith("\n") ? "\n" : "";
  const section = `${prefix}\n# Pongreay: keep local secrets out of Docker images\n${missingEntries.join("\n")}\n`;
  fs.appendFileSync(dockerignoreFile, section, "utf8");
  console.log(`Updated ${dockerignoreFile} to exclude local env files.`);
}

function assertDockerignoreProtectsEnv(): void {
  const dockerignoreFile = ".dockerignore";

  if (!fs.existsSync(dockerignoreFile)) {
    throw new Error(
      `Missing ${dockerignoreFile}. Run: pongreay init, or add .env and .env.* before deploying.`,
    );
  }

  const entries = new Set(
    fs
      .readFileSync(dockerignoreFile, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );
  const missingEntries = [".env", ".env.*"].filter(
    (entry) => !entries.has(entry),
  );

  if (missingEntries.length > 0) {
    throw new Error(
      `${dockerignoreFile} must exclude local env files before deploy. Missing: ${missingEntries.join(", ")}`,
    );
  }
}

function assertEnvFileOutsideApp(envFileOnServer: string): void {
  if (!envFileOnServer.startsWith("/etc/pongreay/")) {
    throw new Error(
      `envFileOnServer must be outside the app directory, preferably under /etc/pongreay/. Current: ${envFileOnServer}`,
    );
  }
}

function validateConfig(): PongreayConfig {
  const config = loadConfig();

  if (!config.environments || Object.keys(config.environments).length === 0) {
    throw new Error("At least one environment is required.");
  }

  for (const [name, env] of Object.entries(config.environments)) {
    const requiredFields: Array<keyof PongreayEnvironment> = [
      "server",
      "branch",
      "appName",
      "imageName",
      "envFileOnServer",
      "hostPort",
      "containerPort",
    ];

    for (const field of requiredFields) {
      if (env[field] === undefined || env[field] === "") {
        throw new Error(`Missing environments.${name}.${field}`);
      }
    }

    assertEnvFileOutsideApp(env.envFileOnServer);
  }

  assertDockerignoreProtectsEnv();
  return config;
}

async function assertBranch(requiredBranch: string): Promise<void> {
  const currentBranch = await output("git", ["branch", "--show-current"]);

  if (currentBranch !== requiredBranch) {
    throw new Error(
      `Wrong branch. Current: ${currentBranch}, required: ${requiredBranch}`,
    );
  }
}

async function assertCleanGit(): Promise<void> {
  const status = await output("git", ["status", "--short"]);

  if (status) {
    throw new Error("Git is not clean. Commit or stash changes first.");
  }
}

async function deploy(
  environmentName: string,
  options: DeployOptions,
): Promise<void> {
  const config = loadConfig();
  const env = getEnvironment(config, environmentName);
  const healthTimeout = parsePositiveInteger(
    options.timeout,
    DEFAULT_HEALTH_TIMEOUT_SECONDS,
  );
  const keepImages = parsePositiveInteger(
    options.keepImages,
    DEFAULT_KEEP_IMAGES,
  );

  if (environmentName === "production" && !options.confirm) {
    throw new Error(
      "Production deploy blocked. Use: pongreay production --confirm",
    );
  }

  console.log("");
  console.log("Pongreay Auto Deployment");
  console.log("------------------------");
  console.log(`Project: ${config.project}`);
  console.log(`Environment: ${environmentName}`);
  console.log(`Server: ${env.server}`);
  console.log(`Branch: ${env.branch}`);
  console.log(`Container: ${env.appName}`);
  console.log(`Image: ${env.imageName}`);
  console.log(`Port: ${env.hostPort}:${env.containerPort}`);
  console.log("");

  if (options.dryRun) {
    console.log("Dry run only. No deployment executed.");
    return;
  }

  await assertBranch(env.branch);
  await assertCleanGit();
  assertDockerignoreProtectsEnv();
  assertEnvFileOutsideApp(env.envFileOnServer);

  if (!options.skipTests) {
    console.log("Running tests...");
    await run("npm", ["test"]);
  }

  const commitHash = await output("git", ["rev-parse", "--short", "HEAD"]);
  const imageTag = `${env.imageName}:${environmentName}-${commitHash}`;
  const tarFile = `${os.tmpdir()}/${env.imageName}-${environmentName}-${commitHash}.tar`;
  const buildArgs = options.buildArg ?? [];
  const dockerBuildArgs = [
    "build",
    ...(options.noCache ? ["--no-cache"] : []),
    ...buildArgs.flatMap((arg) => ["--build-arg", arg]),
    "-t",
    imageTag,
    ".",
  ];

  console.log(`Building Docker image: ${imageTag}`);
  await run("docker", dockerBuildArgs);

  console.log("Saving Docker image...");
  await runShell(`docker save ${imageTag} > ${tarFile}`);

  console.log("Uploading image to server...");
  const remoteTarFile = `/tmp/${env.imageName}-${environmentName}-${commitHash}.tar`; await run("scp", [tarFile, `${env.server}:${remoteTarFile}`]);

  const remoteCommand = `
set -e

APP_NAME=${shellQuote(env.appName)}
IMAGE_REPO=${shellQuote(env.imageName)}
ENV_NAME=${shellQuote(environmentName)}
IMAGE_TAG=${shellQuote(imageTag)}
IMAGE_FILE=${shellQuote(remoteTarFile)}
ENV_FILE=${shellQuote(env.envFileOnServer)}
HOST_PORT=${shellQuote(env.hostPort)}
CONTAINER_PORT=${shellQuote(env.containerPort)}
HEALTH_URL=${shellQuote(`http://127.0.0.1:${env.hostPort}${config.healthPath}`)}
HEALTH_TIMEOUT=${shellQuote(healthTimeout)}
KEEP_IMAGES=${shellQuote(keepImages)}

echo "Checking env file..."
if [ ! -f "$ENV_FILE" ]; then
  echo "Env file does not exist: $ENV_FILE"
  echo "Create it on the server, then set owner to the deploy user or root and permissions to 600."
  exit 1
fi

if [ ! -r "$ENV_FILE" ]; then
  echo "Env file is not readable by $(id -un): $ENV_FILE"
  exit 1
fi

ENV_OWNER=$(stat -c "%U" "$ENV_FILE")
CURRENT_USER=$(id -un)

if [ "$ENV_OWNER" != "$CURRENT_USER" ] && [ "$ENV_OWNER" != "root" ]; then
  echo "Env file owner must be $CURRENT_USER or root. Current owner: $ENV_OWNER"
  exit 1
fi

chmod 600 "$ENV_FILE" 2>/dev/null || true
ENV_PERMS=$(stat -c "%a" "$ENV_FILE")

if [ "$ENV_PERMS" != "600" ] && [ "$ENV_PERMS" != "400" ]; then
  echo "Env file permissions must be 600 or 400. Current permissions: $ENV_PERMS"
  exit 1
fi

echo "Remember old image..."
OLD_IMAGE=$(docker inspect --format='{{.Config.Image}}' "$APP_NAME" 2>/dev/null || true)

echo "Loading Docker image..."
docker load < "$IMAGE_FILE"

echo "Stopping old container..."
docker stop "$APP_NAME" 2>/dev/null || true
docker rm "$APP_NAME" 2>/dev/null || true

echo "Starting new container..."
docker run -d \\
  --name "$APP_NAME" \\
  --restart unless-stopped \\
  --env-file "$ENV_FILE" \\
  --label "pongreay.environment=$ENV_NAME" \\
  --label "pongreay.previous-image=$OLD_IMAGE" \\
  -p "$HOST_PORT:$CONTAINER_PORT" \\
  "$IMAGE_TAG"

echo "Checking health..."
SUCCESS=false
ATTEMPTS=$(( (HEALTH_TIMEOUT + 2) / 3 ))

for i in $(seq 1 "$ATTEMPTS"); do
  if curl -fsS "$HEALTH_URL" > /dev/null; then
    SUCCESS=true
    break
  fi

  echo "Health check failed. Retry $i..."
  sleep 3
done

if [ "$SUCCESS" = "true" ]; then
  echo "Deployment success."
  rm -f "$IMAGE_FILE"
  if [ "$KEEP_IMAGES" -gt 0 ]; then
    docker images "$IMAGE_REPO" --format '{{.Repository}}:{{.Tag}}' \\
      | grep ":$ENV_NAME-" \\
      | tail -n +"$((KEEP_IMAGES + 1))" \\
      | xargs -r docker rmi 2>/dev/null || true
  fi
  exit 0
fi

echo "Deployment failed. Rolling back..."

docker stop "$APP_NAME" 2>/dev/null || true
docker rm "$APP_NAME" 2>/dev/null || true

if [ -n "$OLD_IMAGE" ]; then
  docker run -d \\
    --name "$APP_NAME" \\
    --restart unless-stopped \\
    --env-file "$ENV_FILE" \\
    --label "pongreay.environment=$ENV_NAME" \\
    -p "$HOST_PORT:$CONTAINER_PORT" \\
    "$OLD_IMAGE"
fi

rm -f "$IMAGE_FILE"
exit 1
`;

  console.log("Running remote deploy...");
  await run("ssh", [env.server, remoteCommand]);

  console.log("");
  console.log("Deployment successful.");
}

async function showLogs(
  environmentName: string,
  options: { tail?: string },
): Promise<void> {
  const config = loadConfig();
  const env = getEnvironment(config, environmentName);
  const tail = parsePositiveInteger(options.tail, 200);

  await run("ssh", [
    env.server,
    `docker logs --tail ${shellQuote(tail)} -f ${shellQuote(env.appName)}`,
  ]);
}

async function showStatus(environmentName: string): Promise<void> {
  const config = loadConfig();
  const env = getEnvironment(config, environmentName);
  const command = `
APP_NAME=${shellQuote(env.appName)}
HEALTH_URL=${shellQuote(`http://127.0.0.1:${env.hostPort}${config.healthPath}`)}

echo "Container:"
docker ps -a --filter "name=^/$APP_NAME$" --format "name={{.Names}} status={{.Status}} image={{.Image}} ports={{.Ports}}"
echo ""
echo "Image:"
docker inspect --format='{{.Config.Image}}' "$APP_NAME" 2>/dev/null || true
echo ""
echo "Health:"
curl -fsS "$HEALTH_URL" >/dev/null && echo "healthy: $HEALTH_URL" || echo "unhealthy: $HEALTH_URL"
`;

  await run("ssh", [env.server, command]);
}

async function rollback(environmentName: string): Promise<void> {
  const config = loadConfig();
  const env = getEnvironment(config, environmentName);
  const command = `
set -e

APP_NAME=${shellQuote(env.appName)}
ENV_NAME=${shellQuote(environmentName)}
ENV_FILE=${shellQuote(env.envFileOnServer)}
HOST_PORT=${shellQuote(env.hostPort)}
CONTAINER_PORT=${shellQuote(env.containerPort)}
HEALTH_URL=${shellQuote(`http://127.0.0.1:${env.hostPort}${config.healthPath}`)}

PREVIOUS_IMAGE=$(docker inspect --format='{{ index .Config.Labels "pongreay.previous-image" }}' "$APP_NAME" 2>/dev/null || true)

if [ -z "$PREVIOUS_IMAGE" ] || [ "$PREVIOUS_IMAGE" = "<no value>" ]; then
  echo "No previous image recorded for $APP_NAME."
  exit 1
fi

echo "Rolling back $APP_NAME to $PREVIOUS_IMAGE..."
docker stop "$APP_NAME" 2>/dev/null || true
docker rm "$APP_NAME" 2>/dev/null || true
docker run -d \\
  --name "$APP_NAME" \\
  --restart unless-stopped \\
  --env-file "$ENV_FILE" \\
  --label "pongreay.environment=$ENV_NAME" \\
  -p "$HOST_PORT:$CONTAINER_PORT" \\
  "$PREVIOUS_IMAGE"

curl -fsS "$HEALTH_URL" >/dev/null
echo "Rollback successful."
`;

  await run("ssh", [env.server, command]);
}

async function doctor(environmentName?: string): Promise<void> {
  console.log("Pongreay Doctor");
  console.log("---------------");

  const checks = [
    ["git", ["--version"]],
    ["docker", ["--version"]],
    ["ssh", ["-V"]],
    ["scp", ["-V"]],
  ] as const;

  for (const [command, args] of checks) {
    try {
      await output(command, [...args]);
      console.log(`OK local ${command}`);
    } catch {
      console.log(`FAIL local ${command}`);
    }
  }

  const config = validateConfig();
  console.log(`OK ${CONFIG_FILE}`);
  console.log("OK .dockerignore");

  if (!environmentName) return;

  const env = getEnvironment(config, environmentName);
  const remoteCommand = `
set -e
ENV_FILE=${shellQuote(env.envFileOnServer)}
command -v docker >/dev/null && echo "OK remote docker" || echo "FAIL remote docker"
if [ -f "$ENV_FILE" ]; then
  echo "OK remote env exists"
  stat -c "env owner=%U group=%G perms=%a path=%n" "$ENV_FILE"
else
  echo "FAIL remote env missing: $ENV_FILE"
fi
`;

  await run("ssh", [env.server, remoteCommand]);
}

function printEnvSetup(environmentName: string): void {
  const config = loadConfig();
  const env = getEnvironment(config, environmentName);
  const directory = env.envFileOnServer.replace(/\/[^/]+$/, "");
  const deployUser = env.server.includes("@") ? env.server.split("@")[0] : "$USER";

  console.log(`sudo mkdir -p ${shellQuote(directory)}`);
  console.log(`sudo nano ${shellQuote(env.envFileOnServer)}`);
  console.log(
    `sudo chown ${shellQuote(`${deployUser}:${deployUser}`)} ${shellQuote(env.envFileOnServer)}`,
  );
  console.log(`sudo chmod 600 ${shellQuote(env.envFileOnServer)}`);
}

const program = new Command();

program
  .name("pongreay")
  .description("Secure Docker deployment CLI")
  .version("0.1.0");

program
  .command("init")
  .description("Create pongreay.config.yml")
  .option("--hostname <hostname>", "SSH hostname", "deploy")
  .option("--ip <ip>", "Server IP address", "your-ip-address")
  .action((options: { hostname: string; ip: string }) => {
    createDefaultConfig(options.hostname, options.ip);
  });

program
  .command("config")
  .description("Configuration commands")
  .command("validate")
  .description("Validate pongreay.config.yml and local env safeguards")
  .action(() => {
    try {
      validateConfig();
      console.log("Configuration is valid.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

program
  .command("doctor")
  .description("Check local tools, config, and optionally remote environment")
  .argument("[environment]", "environment to check remotely")
  .action(async (environment: string | undefined) => {
    try {
      await doctor(environment);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

const envCommand = program.command("env").description("Environment helpers");

envCommand
  .command("setup")
  .description("Print secure server env-file setup commands")
  .argument("<environment>", "environment to prepare")
  .action((environment: string) => {
    try {
      printEnvSetup(environment);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

program
  .command("logs")
  .description("Tail remote container logs")
  .argument("<environment>", "environment to inspect")
  .option("--tail <lines>", "number of log lines", "200")
  .action(async (environment: string, options: { tail?: string }) => {
    try {
      await showLogs(environment, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Show remote container and health status")
  .argument("<environment>", "environment to inspect")
  .action(async (environment: string) => {
    try {
      await showStatus(environment);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

program
  .command("rollback")
  .description("Rollback to the previous image recorded by the last deploy")
  .argument("<environment>", "environment to rollback")
  .action(async (environment: string) => {
    try {
      await rollback(environment);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

program
  .argument("[environment]", "uat or production")
  .option("--confirm", "confirm production deployment")
  .option("--dry-run", "preview only")
  .option("--skip-tests", "skip npm test")
  .option("--no-cache", "build Docker image without cache")
  .option("--build-arg <arg>", "pass Docker build argument", collect, [])
  .option("--timeout <seconds>", "health-check timeout in seconds", "30")
  .option("--keep-images <count>", "remote images to keep after success", "5")
  .action(async (environment: string | undefined, options: DeployOptions) => {
    try {
      if (!environment) {
        program.help();
        return;
      }

      await deploy(environment, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

program.parse();


