#!/usr/bin/env node

import { Command } from "commander";
import fs from "fs";
import YAML from "yaml";

const CONFIG_FILE = "pongreay.config.yml";

type EnvironmentName = string;

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
  environments: Record<EnvironmentName, PongreayEnvironment>;
}

interface DeployOptions {
  confirm?: boolean;
  dryRun?: boolean;
}

function createDefaultConfig(): void {
  const config = `project: my-nestjs-api
healthPath: /health

environments:
  uat:
    server: deploy@uat.example.com
    branch: develop
    appName: my-nestjs-api-uat
    imageName: my-nestjs-api
    envFileOnServer: /opt/pongreay/my-nestjs-api/uat.env
    hostPort: 3000
    containerPort: 3000

  production:
    server: deploy@api.example.com
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
  const parsedConfig = YAML.parse(rawConfig) as PongreayConfig;

  validateConfig(parsedConfig);

  return parsedConfig;
}

function validateConfig(config: PongreayConfig): void {
  if (!config.project) {
    throw new Error("Missing config field: project");
  }

  if (!config.healthPath) {
    throw new Error("Missing config field: healthPath");
  }

  if (!config.environments) {
    throw new Error("Missing config field: environments");
  }
}

function deploy(environmentName: string, options: DeployOptions): void {
  const config = loadConfig();
  const environment = config.environments[environmentName];

  if (!environment) {
    throw new Error(`Unknown environment: ${environmentName}`);
  }

  if (environmentName === "production" && !options.confirm) {
    throw new Error(
      "Production deploy blocked. Use: pongreay production --confirm",
    );
  }

  console.log("");
  console.log("Pongreay Deployment Plan");
  console.log("------------------------");
  console.log(`Project: ${config.project}`);
  console.log(`Environment: ${environmentName}`);
  console.log(`Server: ${environment.server}`);
  console.log(`Required branch: ${environment.branch}`);
  console.log(`App name: ${environment.appName}`);
  console.log(`Docker image: ${environment.imageName}`);
  console.log(`Env file on server: ${environment.envFileOnServer}`);
  console.log(`Port: ${environment.hostPort}:${environment.containerPort}`);
  console.log(`Health check: ${config.healthPath}`);
  console.log("");

  if (options.dryRun) {
    console.log("Dry run only. No deployment executed.");
    return;
  }

  console.log("Deployment logic will be added next.");
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
    try {
      createDefaultConfig();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

program
  .argument("[environment]", "uat or production")
  .option("--confirm", "confirm production deployment")
  .option("--dry-run", "preview deployment only")
  .action((environment: string | undefined, options: DeployOptions) => {
    try {
      if (!environment) {
        program.help();
        return;
      }

      deploy(environment, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

program.parse();
