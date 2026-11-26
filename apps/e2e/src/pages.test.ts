import assert from "node:assert/strict";
import { test } from "node:test";
// ponytail: relative import, not a workspace dependency on the web app, for one list.
import { SWEDISH_PATHS } from "../../web/src/i18n/language.ts";
import { edgePages } from "./edge.ts";

test("the edge function knows every page, in English and in Swedish, and nothing else", () => {
  assert.deepEqual(
    [...edgePages].sort(),
    [
      "/",
      ...Object.keys(SWEDISH_PATHS),
      "/sv",
      ...Object.values(SWEDISH_PATHS).map((path) => `/sv${path}`),
    ].sort(),
  );
});
