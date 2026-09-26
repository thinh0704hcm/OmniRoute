import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const dockerfile = fs.readFileSync(path.resolve(import.meta.dirname, "../../Dockerfile"), "utf8");

test("Docker runner exposes the exact build SHA through OCI metadata and runtime env", () => {
  const runner = dockerfile.slice(dockerfile.indexOf("FROM base AS runner-base"));
  assert.match(runner, /ARG OMNIROUTE_BUILD_SHA/);
  assert.match(runner, /org\.opencontainers\.image\.revision="\$\{OMNIROUTE_BUILD_SHA\}"/);
  assert.match(runner, /ENV OMNIROUTE_BUILD_SHA="\$\{OMNIROUTE_BUILD_SHA\}"/);
});
