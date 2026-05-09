#!/usr/bin/env node

import { Command } from "commander";
import fs from "node:fs";
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
}

function run(command: string, args: string[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false,
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
      shell: false,
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

function createDefaultConfig(): void {
  const config = `project: my-nestjs-api
healthPath: /health

environments:
  uat:
    server: deploy@172.20.15.41
    branch: develop
    appName: my-nestjs-api-uat
    imageName: my-nestjs-api
    envFileOnServer: /opt/pongreay/my-nestjs-api/uat.env
    hostPort: 3000
    containerPort: 3000

  production:
    server: deploy@172.20.15.41
    branch: main
    appName: my-nestjs-api
    imageName: my-nestjs-api
    envFileOnServer: /opt/pongreay/my-nestjs-api/production.env
    hostPort: 3000
    containerPort: 3000
`;

  if (fs.existsSync(CONFIG_FILE)) {
    console.log(`${CONFIG_FILE} already exists.`);
    return;
  }

  fs.writeFileSync(CONFIG_FILE, config, "utf8");
  console.log(`Created ${CONFIG_FILE}`);
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
  const env = config.environments[environmentName];

  if (!env) {
    throw new Error(`Unknown environment: ${environmentName}`);
  }

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

  if (!options.skipTests) {
    console.log("Running tests...");
    await run("npm", ["test"]);
  }

  const commitHash = await output("git", ["rev-parse", "--short", "HEAD"]);
  const imageTag = `${env.imageName}:${environmentName}-${commitHash}`;
  const tarFile = `/tmp/${env.imageName}-${environmentName}-${commitHash}.tar.gz`;

  console.log(`Building Docker image: ${imageTag}`);
  await run("docker", ["build", "-t", imageTag, "."]);

  console.log("Saving Docker image...");
  await runShell(`docker save ${imageTag} | gzip > ${tarFile}`);

  console.log("Uploading image to server...");
  await run("scp", [tarFile, `${env.server}:${tarFile}`]);

  const remoteCommand = `
set -e

APP_NAME="${env.appName}"
IMAGE_TAG="${imageTag}"
IMAGE_FILE="${tarFile}"
ENV_FILE="${env.envFileOnServer}"
HOST_PORT="${env.hostPort}"
CONTAINER_PORT="${env.containerPort}"
HEALTH_URL="http://127.0.0.1:${env.hostPort}${config.healthPath}"

echo "Checking env file..."
test -f "$ENV_FILE"

echo "Remember old image..."
OLD_IMAGE=$(docker inspect --format='{{.Config.Image}}' "$APP_NAME" 2>/dev/null || true)

echo "Loading Docker image..."
gunzip -c "$IMAGE_FILE" | docker load

echo "Stopping old container..."
docker stop "$APP_NAME" 2>/dev/null || true
docker rm "$APP_NAME" 2>/dev/null || true

echo "Starting new container..."
docker run -d \\
  --name "$APP_NAME" \\
  --restart unless-stopped \\
  --env-file "$ENV_FILE" \\
  -p "$HOST_PORT:$CONTAINER_PORT" \\
  "$IMAGE_TAG"

echo "Checking health..."
SUCCESS=false

for i in 1 2 3 4 5 6 7 8 9 10; do
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

const program = new Command();

program
  .name("pongreay")
  .description("Secure Docker deployment CLI")
  .version("0.1.0");

program
  .command("init")
  .description("Create pongreay.config.yml")
  .action(() => {
    createDefaultConfig();
  });

program
  .argument("[environment]", "uat or production")
  .option("--confirm", "confirm production deployment")
  .option("--dry-run", "preview only")
  .option("--skip-tests", "skip npm test")
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
