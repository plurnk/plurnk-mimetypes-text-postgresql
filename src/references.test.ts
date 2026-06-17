import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertHandlerConformance } from "@plurnk/plurnk-mimetypes/conformance";
import TextPostgresql from "./TextPostgresql.ts";

const h = () =>
    new TextPostgresql({ mimetype: "text/x-pgsql", glyph: "🐘", extensions: [".sql"] as const });

// Schema-qualified names are kept verbatim: extractRaw names the users def
// `public.users` (the qualified_name's full text), so refs match that exact
// form to join. Bare `orders` defs join to bare `orders` refs. This mirrors
// SQL's own resolution: a ref joins to a def only when written with the same
// qualification (search_path resolution is out of scope, by design).
const SQL = `-- CommentDecoy: not a table
CREATE TABLE public.users (
  id INTEGER PRIMARY KEY,
  name TEXT DEFAULT 'StringDecoy'
);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES public.users(id),
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE VIEW active_orders AS
  SELECT o.id, u.name
  FROM orders o
  JOIN public.users u ON u.id = o.user_id;
CREATE INDEX idx_user ON orders (user_id);
CREATE TRIGGER trg_audit AFTER INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION audit_fn();
`;

describe("text/x-pgsql references (ANTLR refs grind)", () => {
    it("emits the SQL dependency graph with conformance invariants", async () => {
        const handler = h();
        const symbols = await handler.extractRaw(SQL);
        const refs = await handler.references(SQL);
        const defNames = new Set(symbols.map((s) => s.name));

        assert.ok(refs.length > 0, "produces refs");
        // Invariants (mirror the framework conformance harness).
        for (const r of refs) {
            assert.ok(r.line >= 1 && r.column >= 1, `1-indexed: ${r.name}`);
            assert.equal(typeof r.endColumn, "number");
            assert.equal(r.kind, "use", "SQL refs are declared dependencies");
            // No string-literal / comment leakage.
            assert.notEqual(r.name, "StringDecoy");
            assert.notEqual(r.name, "CommentDecoy");
        }

        // The graph edges, by container (the created object) → used table.
        const edge = (container: string, name: string) =>
            refs.some((r) => r.container === container && r.name === name);

        // View reads its source tables (FROM + JOIN), schema-qualified verbatim.
        assert.ok(edge("active_orders", "orders"), "view → orders");
        assert.ok(edge("active_orders", "public.users"), "view → public.users");
        // FK dependency — both the inline REFERENCES and the table-level
        // FOREIGN KEY constraint resolve to the same target.
        assert.ok(edge("orders", "public.users"), "orders FK → public.users");
        // Index attaches to its ON table.
        assert.ok(edge("idx_user", "orders"), "index → orders");
        // Trigger fires ON its table.
        assert.ok(edge("trg_audit", "orders"), "trigger → orders");

        // Join proof: the view/FK edges resolve to local table defs.
        assert.ok(defNames.has("public.users") && defNames.has("orders"));
        // A def's own name never appears as a ref (no self-reference).
        assert.ok(!refs.some((r) => r.name === r.container));
    });

    it("passes the SPEC §16 conformance harness", async () => {
        await assertHandlerConformance(h(), {
            source: SQL,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                { refName: "public.users", container: "active_orders" },
                { refName: "orders", container: "active_orders" },
                { refName: "public.users", container: "orders" },
            ],
            expectRefs: [
                { name: "public.users", kind: "use" },
                { name: "orders", kind: "use" },
            ],
        });
    });
});
