import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TextPostgresql from "./TextPostgresql.ts";

const metadata = {
    mimetype: "text/x-pgsql",
    glyph: "🐘",
    extensions: [".sql", ".pgsql"] as const,
};

describe("TextPostgresql — instantiation", () => {
    it("instantiates with metadata", () => {
        const h = new TextPostgresql(metadata);
        assert.equal(h.mimetype, "text/x-pgsql");
        assert.equal(h.glyph, "🐘");
    });
});

describe("TextPostgresql — extract", () => {
    it("extracts CREATE TABLE + columns", () => {
        const h = new TextPostgresql(metadata);
        const src = [
            "CREATE TABLE users (",
            "    id SERIAL PRIMARY KEY,",
            "    name TEXT NOT NULL,",
            "    email TEXT UNIQUE,",
            "    created_at TIMESTAMPTZ DEFAULT NOW()",
            ");",
        ].join("\n");
        const syms = h.extractRaw(src);
        const t = syms.find((s) => s.name === "users" && s.kind === "class");
        assert.ok(t);
        assert.ok(syms.find((s) => s.name === "id"));
        assert.ok(syms.find((s) => s.name === "name"));
        assert.ok(syms.find((s) => s.name === "email"));
        assert.ok(syms.find((s) => s.name === "created_at"));
    });

    it("extracts CREATE VIEW as class", () => {
        const h = new TextPostgresql(metadata);
        const src = "CREATE VIEW active_users AS SELECT * FROM users WHERE deleted_at IS NULL;";
        const syms = h.extractRaw(src);
        const v = syms.find((s) => s.name === "active_users");
        assert.ok(v);
        assert.equal(v.kind, "class");
    });

    it("extracts CREATE INDEX as field", () => {
        const h = new TextPostgresql(metadata);
        const src = [
            "CREATE INDEX idx_users_email ON users (email);",
            "CREATE UNIQUE INDEX idx_users_id ON users (id);",
        ].join("\n");
        const syms = h.extractRaw(src);
        const i1 = syms.find((s) => s.name === "idx_users_email");
        assert.ok(i1);
        assert.equal(i1.kind, "field");
        const i2 = syms.find((s) => s.name === "idx_users_id");
        assert.ok(i2);
    });

    it("extracts CREATE FUNCTION as function", () => {
        const h = new TextPostgresql(metadata);
        const src = [
            "CREATE FUNCTION add(a INTEGER, b INTEGER) RETURNS INTEGER",
            "    LANGUAGE SQL AS $$ SELECT a + b $$;",
        ].join("\n");
        const syms = h.extractRaw(src);
        const f = syms.find((s) => s.name === "add");
        assert.ok(f);
        assert.equal(f.kind, "function");
    });

    it("extracts CREATE PROCEDURE as function", () => {
        const h = new TextPostgresql(metadata);
        const src = [
            "CREATE PROCEDURE refresh_stats() LANGUAGE SQL AS $$ ANALYZE; $$;",
        ].join("\n");
        const syms = h.extractRaw(src);
        const p = syms.find((s) => s.name === "refresh_stats");
        assert.ok(p);
        assert.equal(p.kind, "function");
    });

    it("extracts CREATE SCHEMA as module", () => {
        const h = new TextPostgresql(metadata);
        const src = "CREATE SCHEMA auth;";
        const syms = h.extractRaw(src);
        const s = syms.find((sym) => sym.name === "auth");
        assert.ok(s);
        assert.equal(s.kind, "module");
    });

    it("extracts CREATE SEQUENCE as field", () => {
        const h = new TextPostgresql(metadata);
        const src = "CREATE SEQUENCE order_id_seq START 1000;";
        const syms = h.extractRaw(src);
        const sq = syms.find((s) => s.name === "order_id_seq");
        assert.ok(sq);
        assert.equal(sq.kind, "field");
    });

    it("extracts CREATE TRIGGER as method", () => {
        const h = new TextPostgresql(metadata);
        const src = [
            "CREATE TRIGGER touch_updated_at",
            "    BEFORE UPDATE ON users",
            "    FOR EACH ROW EXECUTE FUNCTION update_timestamp();",
        ].join("\n");
        const syms = h.extractRaw(src);
        const t = syms.find((s) => s.name === "touch_updated_at");
        assert.ok(t);
        assert.equal(t.kind, "method");
    });

    it("excludes DML and PL statements", () => {
        const h = new TextPostgresql(metadata);
        const src = [
            "BEGIN;",
            "INSERT INTO users (id, name) VALUES (1, 'a');",
            "UPDATE users SET name = 'b' WHERE id = 1;",
            "SELECT * FROM users;",
            "DELETE FROM users;",
            "COMMIT;",
            "CREATE TABLE t (id INTEGER);",
        ].join("\n");
        const syms = h.extractRaw(src);
        const names = syms.map((s) => s.name);
        assert.deepEqual(names.toSorted(), ["id", "t"]);
    });

    it("returns empty array for empty input", () => {
        const h = new TextPostgresql(metadata);
        assert.deepEqual(h.extractRaw(""), []);
    });

    it("does not throw on malformed source (graceful)", () => {
        const h = new TextPostgresql(metadata);
        assert.doesNotThrow(() => h.extractRaw("CREATE TABLE ( broken"));
        assert.doesNotThrow(() => h.extractRaw("@@ totally bogus"));
    });
});

describe("TextPostgresql — framework integration", () => {
    it("renders extracted hierarchy via format()", async () => {
        const h = new TextPostgresql(metadata);
        const out = await h.symbolsRaw("CREATE TABLE answers (id INTEGER);");
        assert.ok(out.includes("class answers"));
    });

    it("jsonpath dispatches against the deep-json ANTLR parse tree (issue #10)", async () => {
        // Every ANTLR deep tree has a root with a `type` field — verify
        // jsonpath reaches it via the deep-channel dispatch.
        const h = new TextPostgresql(metadata);
        const roots = await h.query("class Probe {}", "jsonpath", "$.type");
        assert.equal(roots.length, 1);
        assert.equal(typeof roots[0].matched, "string");
    });
});

// Real-world smoke against a representative PG migration.
describe("TextPostgresql — real-world smoke (migration-shape)", () => {
    const SRC = [
        "CREATE SCHEMA auth;",
        "",
        "CREATE TABLE users (",
        "    id BIGSERIAL PRIMARY KEY,",
        "    email TEXT NOT NULL UNIQUE,",
        "    name TEXT NOT NULL,",
        "    created_at TIMESTAMPTZ DEFAULT NOW(),",
        "    updated_at TIMESTAMPTZ DEFAULT NOW()",
        ");",
        "",
        "CREATE INDEX idx_users_email ON users (email);",
        "",
        "CREATE TABLE posts (",
        "    id BIGSERIAL PRIMARY KEY,",
        "    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
        "    title TEXT NOT NULL,",
        "    body TEXT,",
        "    published_at TIMESTAMPTZ",
        ");",
        "",
        "CREATE INDEX idx_posts_user_id ON posts (user_id);",
        "",
        "CREATE VIEW active_posts AS",
        "    SELECT p.* FROM posts p WHERE p.published_at IS NOT NULL;",
        "",
        "CREATE SEQUENCE order_id_seq START 1000;",
        "",
        "CREATE FUNCTION update_timestamp() RETURNS TRIGGER LANGUAGE plpgsql AS $$",
        "BEGIN",
        "    NEW.updated_at = NOW();",
        "    RETURN NEW;",
        "END;",
        "$$;",
        "",
        "CREATE TRIGGER touch_users_updated_at",
        "    BEFORE UPDATE ON users",
        "    FOR EACH ROW EXECUTE FUNCTION update_timestamp();",
    ].join("\n");

    it("surfaces schema + tables + columns + indexes + view + sequence + function + trigger", () => {
        const h = new TextPostgresql(metadata);
        const syms = h.extractRaw(SRC);
        const names = new Set(syms.map((s) => s.name));

        assert.ok(names.has("auth"));
        assert.ok(names.has("users"));
        assert.ok(names.has("posts"));
        assert.ok(names.has("active_posts"));
        assert.ok(names.has("order_id_seq"));

        assert.ok(names.has("email"));
        assert.ok(names.has("title"));
        assert.ok(names.has("user_id"));

        assert.ok(names.has("idx_users_email"));
        assert.ok(names.has("idx_posts_user_id"));

        assert.ok(names.has("update_timestamp"));
        assert.ok(names.has("touch_users_updated_at"));
    });

    it("kind discrimination across the migration", () => {
        const h = new TextPostgresql(metadata);
        const syms = h.extractRaw(SRC);
        const byNameKind = new Map(syms.map((s) => [`${s.name}:${s.kind}`, s]));
        assert.ok(byNameKind.has("auth:module"));
        assert.ok(byNameKind.has("users:class"));
        assert.ok(byNameKind.has("active_posts:class"));
        assert.ok(byNameKind.has("update_timestamp:function"));
        assert.ok(byNameKind.has("touch_users_updated_at:method"));
        assert.ok(byNameKind.has("order_id_seq:field"));
    });
});
