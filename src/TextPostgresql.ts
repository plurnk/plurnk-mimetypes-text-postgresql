import { AntlrExtractor, withExtractor } from "@plurnk/plurnk-mimetypes";
import type { ExtractionVisitor } from "@plurnk/plurnk-mimetypes";
import { CharStream, CommonTokenStream } from "antlr4ng";
import { PostgreSQLLexer } from "./generated/PostgreSQLLexer.ts";
import { PostgreSQLParser } from "./generated/PostgreSQLParser.ts";
import { PostgreSQLParserVisitor } from "./generated/PostgreSQLParserVisitor.ts";

// text/x-postgresql-sql handler. ANTLR grammar from grammars-v4/sql/postgresql.
//
// Parser entry rule: root.
export default class TextPostgresql extends AntlrExtractor {
    protected parseTree(content: string): unknown {
        const lexer = new PostgreSQLLexer(CharStream.fromString(content));
        const tokens = new CommonTokenStream(lexer);
        const parser = new PostgreSQLParser(tokens);
        parser.removeErrorListeners();
        return parser.root();
    }

    protected createVisitor(): ExtractionVisitor {
        return new TextPostgresqlVisitor() as unknown as ExtractionVisitor;
    }
}

// SPEC §3 mapping for PostgreSQL source files:
//   CREATE TABLE name (cols)         → class (name); each columnDef → field
//   CREATE VIEW name AS              → class
//   CREATE INDEX name ON table       → field
//   CREATE TRIGGER name              → method
//   CREATE FUNCTION name (args) RETURNS → function
//   CREATE PROCEDURE name (args)     → function
//   CREATE SCHEMA name               → module
//   CREATE SEQUENCE name             → field (sequences are number-generators)
//   CREATE TYPE name                 → type (defined via definestmt)
//   CREATE AGGREGATE / OPERATOR      → function (via definestmt)
//   SELECT / INSERT / UPDATE / DELETE → excluded
//   PL/pgSQL bodies                  → not parsed by this grammar (function
//                                      body strings are opaque token sequences)
class TextPostgresqlVisitor extends withExtractor(PostgreSQLParserVisitor) {
    visitCreatestmt = (ctx: any): null => {
        if (this.inBody) return null;
        // createstmt covers many alternatives; the qualified_name immediately
        // after TABLE is the table's name.
        const qns = collectChildren(ctx, "qualified_name");
        const tableName = pgNameText(qns[0]);
        if (!tableName) return null;
        this.addSymbol("class", tableName, ctx);

        // Walk for columnDef nodes (within tableelementlist).
        const cols = findDescendants(ctx, "ColumnDefContext");
        for (const col of cols) {
            const colid = (col as { colid?: () => unknown }).colid?.();
            const colName = pgNameText(colid);
            if (colName) this.addSymbol("field", colName, ctx);
        }
        return null;
    };

    visitViewstmt = (ctx: any): null => {
        if (this.inBody) return null;
        const qns = collectChildren(ctx, "qualified_name");
        const name = pgNameText(qns[0]);
        if (name) this.addSymbol("class", name, ctx);
        return null;
    };

    visitIndexstmt = (ctx: any): null => {
        if (this.inBody) return null;
        // indexstmt: CREATE [unique] INDEX [concurrently] [if_not_exists?]
        //   index_name? ON relation_expr ...
        // The index_name is either an `index_name_` rule or a bare `name`
        // alternative — fall back to walking for the first identifier child.
        const inn = ctx.index_name_?.();
        if (inn) {
            const txt = pgNameText(inn);
            if (txt) this.addSymbol("field", txt, ctx);
            return null;
        }
        const nameNode = ctx.name?.();
        if (nameNode) {
            const txt = pgNameText(nameNode);
            if (txt) this.addSymbol("field", txt, ctx);
        }
        return null;
    };

    visitCreatetrigstmt = (ctx: any): null => {
        if (this.inBody) return null;
        // First `name` child is the trigger's own name.
        const names = collectChildren(ctx, "name");
        const name = pgNameText(names[0]);
        if (name) this.addSymbol("method", name, ctx);
        return null;
    };

    visitCreatefunctionstmt = (ctx: any): null => {
        if (this.inBody) return null;
        const fn = ctx.func_name?.();
        const name = pgNameText(fn);
        if (name) this.addSymbol("function", name, ctx);
        return null;
    };

    visitCreateschemastmt = (ctx: any): null => {
        if (this.inBody) return null;
        // CREATE SCHEMA (IF NOT EXISTS)? (schemaname? AUTHORIZATION rolespec | colid)
        const sn = ctx.optschemaname?.();
        const colid = ctx.colid?.();
        const name = pgNameText(sn) ?? pgNameText(colid);
        if (name) this.addSymbol("module", name, ctx);
        return null;
    };

    visitCreateseqstmt = (ctx: any): null => {
        if (this.inBody) return null;
        const qn = ctx.qualified_name?.();
        const name = pgNameText(qn);
        if (name) this.addSymbol("field", name, ctx);
        return null;
    };

    visitDefinestmt = (ctx: any): null => {
        if (this.inBody) return null;
        // definestmt covers: AGGREGATE / OPERATOR / TYPE / TEXT SEARCH
        // PARSER/DICTIONARY/TEMPLATE/CONFIGURATION / COLLATION.
        // Discriminate by which keyword token is present.
        const txt = (ctx.getText?.() ?? "").toLowerCase();
        if (txt.startsWith("createaggregate") || txt.startsWith("createoperator")) {
            const fn = ctx.func_name?.() ?? collectChildren(ctx, "any_name")[0];
            const name = pgNameText(fn);
            if (name) this.addSymbol("function", name, ctx);
            return null;
        }
        if (txt.startsWith("createtype")) {
            const an = collectChildren(ctx, "any_name")[0];
            const name = pgNameText(an);
            if (name) this.addSymbol("type", name, ctx);
            return null;
        }
        // Other variants: surface as type by default.
        const an = collectChildren(ctx, "any_name")[0];
        const name = pgNameText(an);
        if (name) this.addSymbol("type", name, ctx);
        return null;
    };
}

function pgNameText(ctx: unknown): string | null {
    if (!ctx) return null;
    const raw = (ctx as { getText?: () => string }).getText?.();
    if (!raw) return null;
    return unquoteSqlIdentifier(raw);
}

function unquoteSqlIdentifier(s: string): string {
    if (s.length >= 2) {
        const first = s[0];
        const last = s[s.length - 1];
        if (first === '"' && last === '"') return s.slice(1, -1).replace(/""/g, '"');
    }
    return s;
}

function collectChildren(ctx: unknown, methodName: string): unknown[] {
    const node = ctx as Record<string, unknown>;
    const accessor = node[methodName] as ((...args: unknown[]) => unknown) | undefined;
    if (typeof accessor !== "function") return [];
    const raw = accessor.call(node);
    if (Array.isArray(raw)) return raw;
    return raw ? [raw] : [];
}

// DFS descendant search for contexts of the given class name.
function findDescendants(root: unknown, ctxName: string): unknown[] {
    const out: unknown[] = [];
    const stack: unknown[] = [root];
    while (stack.length > 0) {
        const node = stack.pop() as {
            constructor?: { name?: string };
            getChildCount?: () => number;
            getChild?: (i: number) => unknown;
        };
        if (!node) continue;
        if (node.constructor?.name === ctxName) out.push(node);
        const count = node.getChildCount?.() ?? 0;
        for (let i = 0; i < count; i += 1) stack.push(node.getChild?.(i));
    }
    return out;
}
