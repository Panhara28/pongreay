import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";

const cli = resolve("dist/index.js");

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    ...options,
  });
}

test("prints the package version", () => {
  const result = runCli(["--version"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^0\.1\.4\s*$/);
});

test("init creates config and protects local env files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pongreay-test-"));

  try {
    const result = runCli(["init", "--hostname", "deploy", "--ip", "127.0.0.1"], {
      cwd: directory,
    });

    assert.equal(result.status, 0, result.stderr);

    const config = await readFile(join(directory, "pongreay.config.yml"), "utf8");
    assert.match(config, /server: deploy@127\.0\.0\.1/);

    const dockerignore = await readFile(join(directory, ".dockerignore"), "utf8");
    assert.match(dockerignore, /^\.env$/m);
    assert.match(dockerignore, /^\.env\.\*$/m);
    assert.match(dockerignore, /^!\.env\.example$/m);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function withProject(networksYaml, fn) {
  const directory = await mkdtemp(join(tmpdir(), "pongreay-test-"));
  try {
    const init = runCli(["init", "--hostname", "deploy", "--ip", "127.0.0.1"], { cwd: directory });
    assert.equal(init.status, 0, init.stderr);
    const configPath = join(directory, "pongreay.config.yml");
    const config = await readFile(configPath, "utf8");
    // Add the networks setting to every environment.
    await writeFile(configPath, config.replace(/(\n    containerPort: \d+)/g, `$1\n    networks: ${networksYaml}`));
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("config validate accepts a networks list", async () => {
  await withProject("[app-net, shared.net_1]", (cwd) => {
    const result = runCli(["config", "validate"], { cwd });
    assert.equal(result.status, 0, result.stderr);
  });
});

test("config validate rejects an invalid network name", async () => {
  await withProject("['bad name; rm -rf /']", (cwd) => {
    const result = runCli(["config", "validate"], { cwd });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid environments\.\w+\.networks entry/);
  });
});

test("dry run lists the environment's networks", async () => {
  await withProject("app-net", (cwd) => {
    const result = runCli(["uat", "--dry-run"], { cwd });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Networks: app-net/);
  });
});
