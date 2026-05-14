import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  assert.match(result.stdout, /^0\.1\.0\s*$/);
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
