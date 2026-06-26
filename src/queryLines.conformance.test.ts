import { describe, it } from "node:test";
import { assertQueryLineConformance } from "@plurnk/plurnk-mimetypes/conformance";
import Handler from "./TextPostgresql.ts";

// #41: structural matches carry source-line spans (coverage gate).
const h = new Handler({"mimetype":"text/x-pgsql","glyph":"🐘","extensions":[".sql",".pgsql"]});

describe("#41 query-line conformance", () => {
    it("every structural match carries a source-line span", async () => {
        await assertQueryLineConformance(h, [{ source: "CREATE TABLE t (id int);\nSELECT * FROM t;\n", dialect: "jsonpath", pattern: "$..*" }]);
    });
});
