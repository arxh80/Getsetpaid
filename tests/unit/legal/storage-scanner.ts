import ts from "typescript";
import {
  constDeclarations,
  constantString,
  lineOf,
  moduleReferences,
  parse,
  snippet,
  unwrap,
} from "../support/app-source";

// ===========================================================================
// THE STORAGE CENSUS SCANNER (Phase 8 Task 2; rebuilt on the TypeScript
// parser in fix round 1 after review finding I1).
// ===========================================================================
// WHAT IT FINDS, per file:
//
// cookie-write
//   * any `.set(` on a COOKIE STORE, where a cookie store is: the result of
//     calling next/headers' `cookies` under ANY local name (aliased imports,
//     namespace imports, `(await cookies()).set(...)`, `?.set`); anything
//     reached through a member called `cookies` (`res.cookies`,
//     `request.cookies`); the Cookie Store API (`cookieStore`,
//     `window.cookieStore`); and any variable ASSIGNED one of those, to any
//     depth of aliasing;
//   * a cookie store that ESCAPES -- passed to a function, returned, put in an
//     object, destructured for anything but its read methods
//     (`const { set } = await cookies()`), a write method taken without being
//     called (`const f = store.set`), or a computed member on it -- because
//     what happens to it next is not visible here;
//   * next/headers' `cookies` function itself escaping as a value;
//   * an assignment to any member named `cookie` (`document.cookie = ...`,
//     `d["cookie"] += ...`, an aliased `document`);
//   * any constant string (literals, `"Set-" + "Cookie"`, constant templates,
//     JSX attribute values such as `httpEquiv="set-cookie"`) containing
//     `set-cookie`;
//   * the @supabase/ssr adapter's `setAll` (declared or called).
// supabase-client
//   * a call to createBrowserClient / createServerClient / createClient
//     imported from @supabase/ssr or @supabase/supabase-js, under any local
//     name (a browser supabase-js client persists its session to
//     localStorage by default).
// web-storage-write
//   * the same store analysis for `localStorage` / `sessionStorage`, however
//     reached: bare, `window.` / `globalThis.` / `self.`, `?.`, bracketed
//     (`window["local" + "Storage"]`), or through an alias; a write is
//     `setItem(`, a member or index assignment, or an escape as above.
// indexeddb       `indexedDB`, `IDBFactory`, `IDBDatabase`, `openDatabase`.
// cache-storage   `caches`, `serviceWorker`, `navigator.storage`.
// third-party
//   * `next/script` and `@next/third-parties` imports (static, dynamic,
//     require), a module specifier that is an absolute URL, and a dynamic
//     `import()` whose specifier is not a constant;
//   * JSX `<script>`, `<Script>`, `<iframe>`, `<frame>`, `<object>`,
//     `<embed>`, `<portal>`; a `<link>` whose `href` is absolute or not
//     constant; any `src`/`srcSet`/`poster`/`data`/`action`/`formAction`
//     attribute whose constant value is an absolute URL;
//   * `createElement` / `createElementNS` of a loading element, or of a tag
//     that is not constant;
//   * `sendBeacon`, `new Image`, `window.open` / `open(`, an assignment to a
//     `src` member, `innerHTML` / `outerHTML` / `srcdoc` assignment,
//     `insertAdjacentHTML`, `document.write`, `eval`, `new Function`,
//     `importScripts`;
//   * fetch / XMLHttpRequest.open / WebSocket / EventSource / Worker /
//     SharedWorker whose URL argument is a constant absolute URL (a server
//     call is declared as such, and must live in a `server-only` module).
// tracker
//   * an identifier that is a known tracker global (gtag, fbq, dataLayer, ...)
//     and any constant string naming a tracker package or host.
//
// WHAT IT CANNOT SEE, stated so nobody reads more into a green run:
//   * a store reached through a value this file did not create (a parameter,
//     a property of an imported object other than `cookies`/`cookieStore`),
//     a dynamically built global name that is not constant, `Reflect` /
//     `Object.defineProperty` on `document`;
//   * anything a dependency does at runtime (the RUNTIME_DEPENDENCIES
//     declaration is a claim), and anything injected outside the repository.
// Those are what tests/e2e/storage-census.spec.ts exists for -- and that runs
// only on a developer machine, not in CI.
// ===========================================================================

export type SiteKind =
  | "cookie-write"
  | "supabase-client"
  | "web-storage-write"
  | "indexeddb"
  | "cache-storage"
  | "third-party"
  | "tracker";

export interface Site {
  file: string;
  line: number;
  kind: SiteKind;
  /** First argument of a keyed write (the key or cookie name), as written; else null. */
  key: string | null;
  text: string;
}

type StoreKind = "cookie" | "web";

const WEB_STORAGE_NAMES = new Set(["localStorage", "sessionStorage"]);
const COOKIE_MEMBER_NAMES = new Set(["cookies", "cookieStore"]);

/** Members that only read (or remove) and never create storage. */
const READS: Record<StoreKind, ReadonlySet<string>> = {
  cookie: new Set(["get", "getAll", "has", "size", "toString", "delete", "addEventListener", "removeEventListener"]),
  web: new Set(["getItem", "key", "length", "removeItem", "clear", "hasOwnProperty"]),
};
const WRITE_CALLS: Record<StoreKind, ReadonlySet<string>> = {
  cookie: new Set(["set"]),
  web: new Set(["setItem"]),
};
const STORE_SITE: Record<StoreKind, SiteKind> = { cookie: "cookie-write", web: "web-storage-write" };

const TRACKER_IDENTIFIERS = new Set(
  ["gtag", "fbq", "_paq", "dataLayer", "posthog", "mixpanel", "amplitude", "hotjar", "hj", "plausible", "umami", "clarity", "_hsq", "ttq", "snaptr", "twq", "lintrk", "rdt", "heap", "analytics"].map(
    (s) => s.toLowerCase(),
  ),
);
const TRACKER_STRING =
  /\b(?:gtag|fbq|_paq|dataLayer|posthog|mixpanel|amplitude|hotjar|plausible|umami)\b|@vercel\/analytics|@vercel\/speed-insights|@next\/third-parties|@segment\/|googletagmanager|google-analytics|clarity\.ms|connect\.facebook\.net|static\.hotjar|cdn\.segment|doubleclick\.net/i;

const LOADING_TAGS = new Set(["script", "iframe", "frame", "object", "embed", "portal"]);
const CREATE_ELEMENT_LOADING = new Set(["script", "iframe", "frame", "img", "image", "link", "object", "embed", "audio", "video", "source", "portal"]);
const URL_ATTRIBUTES = new Set(["src", "srcset", "poster", "data", "action", "formaction", "background", "srcdoc"]);
const ABSOLUTE_URL = /^\s*(?:(?:https?|wss?):)?\/\//i;
const NETWORK_CALLS = new Set(["fetch", "WebSocket", "EventSource", "Worker", "SharedWorker", "importScripts"]);
const GLOBAL_OBJECTS = new Set(["window", "globalThis", "self", "document"]);

function memberName(
  n: ts.Node,
  consts: ReadonlyMap<string, ts.Expression>,
): { name: string | null } | null {
  if (ts.isPropertyAccessExpression(n)) return { name: n.name.text };
  if (ts.isElementAccessExpression(n)) return { name: constantString(n.argumentExpression, consts) };
  return null;
}

function isInTypePosition(n: ts.Node): boolean {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isTypeNode(p) && !ts.isExpressionWithTypeArguments(p)) return true;
    if (ts.isStatement(p) || ts.isSourceFile(p)) return false;
  }
  return false;
}

/** An identifier used as a VALUE (not a declaration name, property name, label or type). */
function isValueIdentifier(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (
    (ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isClassDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertyAssignment(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodSignature(p) ||
      ts.isGetAccessor(p) ||
      ts.isSetAccessor(p) ||
      ts.isEnumMember(p) ||
      ts.isInterfaceDeclaration(p) ||
      ts.isTypeAliasDeclaration(p) ||
      ts.isJsxAttribute(p) ||
      ts.isLabeledStatement(p) ||
      ts.isImportSpecifier(p) ||
      ts.isExportSpecifier(p) ||
      ts.isImportClause(p) ||
      ts.isNamespaceImport(p) ||
      ts.isImportEqualsDeclaration(p)) &&
    (p as { name?: ts.Node }).name === id
  ) {
    return false;
  }
  if (ts.isBindingElement(p) && (p.name === id || p.propertyName === id)) return false;
  if (ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) return false;
  if (ts.isBreakOrContinueStatement(p)) return false;
  if (ts.isQualifiedName(p)) return false;
  return !isInTypePosition(id);
}

function isAssignmentTarget(n: ts.Node): boolean {
  let cur = n;
  while (ts.isParenthesizedExpression(cur.parent) || ts.isNonNullExpression(cur.parent)) cur = cur.parent;
  const p = cur.parent;
  if (ts.isBinaryExpression(p) && p.left === cur) {
    const k = p.operatorToken.kind;
    return k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;
  }
  if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) &&
    (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)) {
    return true;
  }
  return false;
}

export function scanSource(file: string, raw: string): Site[] {
  const sf = parse(file, raw);
  const consts = constDeclarations(sf);
  const refs = moduleReferences(sf, consts);
  const sites: { pos: number; site: Site }[] = [];
  const seen = new Set<string>();
  const push = (kind: SiteKind, node: ts.Node, key: string | null = null) => {
    const id = `${kind}@${node.getStart(sf)}`;
    if (seen.has(id)) return;
    seen.add(id);
    sites.push({
      pos: node.getStart(sf),
      site: { file, line: lineOf(sf, node), kind, key, text: snippet(sf, node) },
    });
  };

  // ---- bindings that come from modules ------------------------------------
  const cookiesFunctions = new Set<string>(); // local names of next/headers' cookies
  const headersNamespaces = new Set<string>(); // `import * as h from "next/headers"`
  const supabaseFactories = new Set<string>();
  const supabaseNamespaces = new Set<string>();
  for (const ref of refs) {
    const spec = ref.specifier;
    if (spec === "next/headers") {
      for (const b of ref.bindings) {
        if (b.imported === "cookies") cookiesFunctions.add(b.local);
        if (b.imported === "*" || b.imported === "default") headersNamespaces.add(b.local);
      }
    }
    if (spec === "@supabase/ssr" || spec === "@supabase/supabase-js") {
      for (const b of ref.bindings) {
        if (/^create(?:Browser|Server)?Client$/.test(b.imported)) supabaseFactories.add(b.local);
        if (b.imported === "*" || b.imported === "default") supabaseNamespaces.add(b.local);
      }
    }
    if (spec === null) {
      if (ts.isCallExpression(ref.node)) push("third-party", ref.node);
    } else if (
      spec === "next/script" ||
      spec.startsWith("@next/third-parties") ||
      ABSOLUTE_URL.test(spec)
    ) {
      push("third-party", ref.node);
    }
  }
  // `cookies` called by that name is treated as next/headers' even when the
  // import is not visible (re-exported through another module).
  cookiesFunctions.add("cookies");

  // ---- store expressions, with aliasing to a fixpoint ----------------------
  const aliases: Record<StoreKind, Set<string>> = { cookie: new Set(), web: new Set() };

  const isCookiesCall = (x: ts.Expression): boolean => {
    if (!ts.isCallExpression(x)) return false;
    const callee = unwrap(x.expression);
    if (ts.isIdentifier(callee)) return cookiesFunctions.has(callee.text);
    const m = memberName(callee, consts);
    if (m && m.name === "cookies") {
      const obj = unwrap((callee as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression);
      return ts.isIdentifier(obj) && headersNamespaces.has(obj.text);
    }
    return false;
  };

  const storeKind = (e: ts.Expression): StoreKind | null => {
    const x = unwrap(e);
    if (ts.isIdentifier(x)) {
      if (WEB_STORAGE_NAMES.has(x.text) || aliases.web.has(x.text)) return "web";
      if (x.text === "cookieStore" || aliases.cookie.has(x.text)) return "cookie";
      return null;
    }
    const m = memberName(x, consts);
    if (m) {
      if (m.name !== null && WEB_STORAGE_NAMES.has(m.name)) return "web";
      if (m.name !== null && COOKIE_MEMBER_NAMES.has(m.name)) {
        // `h.cookies` on a next/headers namespace is the FUNCTION, not a store.
        const obj = unwrap((x as ts.PropertyAccessExpression).expression);
        if (m.name === "cookies" && ts.isIdentifier(obj) && headersNamespaces.has(obj.text)) return null;
        return "cookie";
      }
      return null;
    }
    if (isCookiesCall(x)) return "cookie";
    if (ts.isBinaryExpression(x)) {
      const k = x.operatorToken.kind;
      if (k === ts.SyntaxKind.AmpersandAmpersandToken) return storeKind(x.right);
      if (k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken) {
        return storeKind(x.left) ?? storeKind(x.right);
      }
      if (k === ts.SyntaxKind.CommaToken) return storeKind(x.right);
      return null;
    }
    if (ts.isConditionalExpression(x)) return storeKind(x.whenTrue) ?? storeKind(x.whenFalse);
    return null;
  };

  const collectAliases = (n: ts.Node): boolean => {
    let changed = false;
    const add = (kind: StoreKind, name: string) => {
      if (!aliases[kind].has(name)) {
        aliases[kind].add(name);
        changed = true;
      }
    };
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const kind = storeKind(node.initializer);
        if (kind && ts.isIdentifier(node.name)) add(kind, node.name.text);
        // `const { localStorage: ls } = window`, `const { cookies: jar } = res`
        if (ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            const prop = el.propertyName ?? el.name;
            const propName = ts.isIdentifier(prop) || ts.isStringLiteral(prop) ? prop.text : null;
            if (!propName || !ts.isIdentifier(el.name)) continue;
            if (WEB_STORAGE_NAMES.has(propName)) add("web", el.name.text);
            if (COOKIE_MEMBER_NAMES.has(propName)) add("cookie", el.name.text);
          }
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        const kind = storeKind(node.right);
        if (kind) add(kind, node.left.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(n);
    return changed;
  };
  let rounds = 0;
  while (rounds++ < 10 && collectAliases(sf)) {
    // until no new alias appears
  }

  /** Is `n` the start of a store chain (not a wrapper around one)? */
  const isStoreOrigin = (n: ts.Node): StoreKind | null => {
    if (ts.isIdentifier(n)) return isValueIdentifier(n) ? storeKind(n) : null;
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n)) {
      return storeKind(n);
    }
    return null;
  };

  /** Classifies one use of a store. */
  const classifyStoreUse = (origin: ts.Expression, kind: StoreKind): void => {
    // Climb through wrappers and value-propagating operators.
    let cur: ts.Node = origin;
    for (;;) {
      const p = cur.parent;
      if (
        ts.isParenthesizedExpression(p) ||
        ts.isAwaitExpression(p) ||
        ts.isNonNullExpression(p) ||
        ts.isAsExpression(p) ||
        ts.isSatisfiesExpression(p) ||
        ts.isTypeAssertionExpression(p)
      ) {
        cur = p;
        continue;
      }
      if (ts.isBinaryExpression(p)) {
        const k = p.operatorToken.kind;
        const valuePosition =
          (k === ts.SyntaxKind.AmpersandAmpersandToken && p.right === cur) ||
          ((k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken)) ||
          (k === ts.SyntaxKind.CommaToken && p.right === cur);
        if (valuePosition) {
          cur = p;
          continue;
        }
      }
      if (ts.isConditionalExpression(p) && p.condition !== cur) {
        cur = p;
        continue;
      }
      break;
    }
    const p = cur.parent;
    const site = STORE_SITE[kind];

    // A member of the store.
    if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === cur) {
      const m = memberName(p, consts)!;
      if (m.name === null) {
        push(site, p);
        return;
      }
      // A member that is itself a store (`window.localStorage` where `window`
      // is not a store never gets here; `x.cookies.cookies` is odd but fine).
      if (isAssignmentTarget(p)) {
        push(site, p, JSON.stringify(m.name));
        return;
      }
      if (WRITE_CALLS[kind].has(m.name)) {
        let callee: ts.Node = p;
        while (ts.isParenthesizedExpression(callee.parent) || ts.isNonNullExpression(callee.parent)) callee = callee.parent;
        const call = callee.parent;
        if (ts.isCallExpression(call) && call.expression === callee) {
          push(site, call, call.arguments[0] ? call.arguments[0].getText(sf) : null);
        } else {
          push(site, p); // `const f = store.set`, `store.set.call(...)`
        }
        return;
      }
      return; // a read, or a member we do not treat as a write
    }
    // Aliased: `const x = store` / `x = store` -- the alias's uses are classified.
    if (ts.isVariableDeclaration(p) && p.initializer === cur) {
      if (ts.isIdentifier(p.name)) return;
      if (ts.isObjectBindingPattern(p.name)) {
        const writes = p.name.elements.filter((el) => {
          if (el.dotDotDotToken) return true;
          const prop = el.propertyName ?? el.name;
          const name = ts.isIdentifier(prop) || ts.isStringLiteral(prop) ? prop.text : null;
          return name === null || !READS[kind].has(name);
        });
        if (writes.length > 0) push(site, p);
        return;
      }
      push(site, p);
      return;
    }
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === cur) {
      if (ts.isIdentifier(p.left)) return;
      push(site, p);
      return;
    }
    // Benign positions: a statement on its own, a test, typeof/void/!.
    if (
      ts.isExpressionStatement(p) ||
      ts.isIfStatement(p) ||
      ts.isWhileStatement(p) ||
      ts.isTypeOfExpression(p) ||
      ts.isVoidExpression(p) ||
      (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) ||
      (ts.isConditionalExpression(p) && p.condition === cur) ||
      (ts.isBinaryExpression(p) &&
        [
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.EqualsEqualsToken,
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
          ts.SyntaxKind.InKeyword,
          ts.SyntaxKind.InstanceOfKeyword,
        ].includes(p.operatorToken.kind))
    ) {
      return;
    }
    // Anything else: the store escapes (an argument, a return value, an
    // object/array element, a spread, a JSX value, a default parameter).
    push(site, p);
  };

  // ---- the walk -------------------------------------------------------------
  const visit = (n: ts.Node): void => {
    // Stores.
    const kind = isStoreOrigin(n);
    if (kind) classifyStoreUse(n as ts.Expression, kind);

    // next/headers' cookies function escaping as a value.
    if (ts.isIdentifier(n) && isValueIdentifier(n) && cookiesFunctions.has(n.text) && n.text !== "cookies") {
      let cur: ts.Node = n;
      while (ts.isParenthesizedExpression(cur.parent) || ts.isNonNullExpression(cur.parent)) cur = cur.parent;
      if (!(ts.isCallExpression(cur.parent) && cur.parent.expression === cur)) push("cookie-write", n);
    }
    if (ts.isIdentifier(n) && isValueIdentifier(n) && n.text === "cookies") {
      let cur: ts.Node = n;
      while (ts.isParenthesizedExpression(cur.parent) || ts.isNonNullExpression(cur.parent)) cur = cur.parent;
      const imported = refs.some((r) => r.specifier === "next/headers" && r.bindings.some((b) => b.local === "cookies"));
      if (imported && !(ts.isCallExpression(cur.parent) && cur.parent.expression === cur)) push("cookie-write", n);
    }

    // Assignment to a `cookie` member, and to `src` / HTML sinks.
    if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && isAssignmentTarget(n)) {
      const m = memberName(n, consts);
      if (m?.name === null) {
        // A computed assignment on document/window could be anything.
        const obj = unwrap(n.expression);
        if (ts.isIdentifier(obj) && GLOBAL_OBJECTS.has(obj.text)) push("third-party", n);
      } else if (m?.name === "cookie") {
        push("cookie-write", n);
      } else if (m && ["src", "innerHTML", "outerHTML", "srcdoc", "srcset", "href"].includes(m.name!)) {
        // `a.href = ...` on an element is navigation, but `link.href` loads;
        // only a document/window location assignment is excluded.
        const obj = unwrap(n.expression);
        const isLocation = ts.isIdentifier(obj) ? obj.text === "location" : memberName(obj, consts)?.name === "location";
        if (!(m.name === "href" && isLocation)) push("third-party", n);
      }
    }

    // Constant strings: set-cookie headers and tracker names/hosts.
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateExpression(n) ||
      (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken)
    ) {
      const parentIsConcat =
        (ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
        ts.isTemplateSpan(n.parent);
      const value = constantString(n as ts.Expression, consts);
      const inImport = ts.isImportDeclaration(n.parent) || ts.isExportDeclaration(n.parent);
      if (value !== null && (!parentIsConcat || constantString(n.parent as ts.Expression, consts) === null)) {
        if (/set-cookie/i.test(value)) push("cookie-write", n);
        if (!inImport && TRACKER_STRING.test(value)) push("tracker", n);
      }
    }
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) {
      const spec = constantString(n.moduleSpecifier as ts.Expression, consts);
      if (spec && (TRACKER_STRING.test(spec) || /^(?:posthog|mixpanel|amplitude|@amplitude|@segment|react-ga|ga-4|@fullstory|@sentry\/replay|hotjar|@hotjar)/i.test(spec))) {
        push("tracker", n);
      }
    }

    // Tracker globals.
    if (ts.isIdentifier(n) && TRACKER_IDENTIFIERS.has(n.text.toLowerCase())) {
      const p = n.parent;
      const isMemberName = ts.isPropertyAccessExpression(p) && p.name === n;
      const obj = isMemberName ? unwrap(p.expression) : null;
      const onGlobal = obj && ts.isIdentifier(obj) && GLOBAL_OBJECTS.has(obj.text);
      if ((isValueIdentifier(n) && n.text !== "analytics" && n.text !== "heap") || onGlobal) push("tracker", n);
    }

    // IndexedDB / WebSQL / Cache Storage / service workers.
    if (ts.isIdentifier(n) || ts.isStringLiteral(n)) {
      const t = n.text;
      const p = n.parent;
      const namePos =
        ts.isIdentifier(n) &&
        (isValueIdentifier(n) || (ts.isPropertyAccessExpression(p) && p.name === n));
      const indexPos = ts.isStringLiteral(n) && ts.isElementAccessExpression(p) && p.argumentExpression === n;
      if (namePos || indexPos) {
        if (/^(?:indexedDB|IDBFactory|IDBDatabase|openDatabase)$/.test(t)) push("indexeddb", n);
        if (t === "serviceWorker") push("cache-storage", n);
        if (t === "caches") push("cache-storage", n);
        if (t === "storage" && (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p))) {
          const obj = unwrap(p.expression);
          const objName = ts.isIdentifier(obj) ? obj.text : memberName(obj, consts)?.name;
          if (objName === "navigator") push("cache-storage", n);
        }
      }
    }

    // JSX.
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = n.tagName.getText(sf);
      const lower = tag.toLowerCase();
      if (LOADING_TAGS.has(lower)) push("third-party", n.tagName);
      for (const attr of n.attributes.properties) {
        if (ts.isJsxSpreadAttribute(attr)) {
          if (tag === "link" || LOADING_TAGS.has(lower)) push("third-party", attr);
          continue;
        }
        const name = attr.name.getText(sf).toLowerCase();
        const init = attr.initializer;
        const valueExpr = !init
          ? undefined
          : ts.isStringLiteral(init)
            ? init
            : ts.isJsxExpression(init)
              ? init.expression
              : undefined;
        const value = constantString(valueExpr, consts);
        if (URL_ATTRIBUTES.has(name) && value !== null && ABSOLUTE_URL.test(value)) push("third-party", attr);
        // Intrinsic `<link>` only: Next's `<Link>` is navigation, not a load.
        if (tag === "link" && name === "href" && (value === null || ABSOLUTE_URL.test(value))) push("third-party", attr);
        if (name === "httpequiv" && value !== null && /set-cookie/i.test(value)) push("cookie-write", attr);
        if (name === "dangerouslysetinnerhtml") push("third-party", attr);
      }
    }

    // Calls and constructions.
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const callee = unwrap(n.expression);
      const args = n.arguments ?? ts.factory.createNodeArray<ts.Expression>();
      const calleeName = ts.isIdentifier(callee) ? callee.text : memberName(callee, consts)?.name ?? null;
      const calleeObj =
        ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) ? unwrap(callee.expression) : null;
      const onGlobal = calleeObj === null || (ts.isIdentifier(calleeObj) && GLOBAL_OBJECTS.has(calleeObj.text));

      if (ts.isCallExpression(n)) {
        if (calleeName === "setAll") push("cookie-write", n);
        if (calleeName && (ts.isIdentifier(callee) ? supabaseFactories.has(calleeName) : false)) push("supabase-client", n);
        if (calleeObj && ts.isIdentifier(calleeObj) && supabaseNamespaces.has(calleeObj.text) && calleeName && /^create(?:Browser|Server)?Client$/.test(calleeName)) {
          push("supabase-client", n);
        }
        if (ts.isIdentifier(callee) && /^create(?:Browser|Server)Client$/.test(callee.text)) push("supabase-client", n);
        if (calleeName === "createElement" || calleeName === "createElementNS") {
          const tagArg = calleeName === "createElementNS" ? args[1] : args[0];
          const tag = constantString(tagArg, consts);
          if (tag === null || CREATE_ELEMENT_LOADING.has(tag.toLowerCase())) push("third-party", n);
        }
        if (calleeName === "sendBeacon") push("third-party", n);
        if (calleeName === "insertAdjacentHTML") push("third-party", n);
        if ((calleeName === "write" || calleeName === "writeln") && calleeObj && ts.isIdentifier(calleeObj) && calleeObj.text === "document") {
          push("third-party", n);
        }
        if (calleeName === "open" && onGlobal) push("third-party", n);
        if (calleeName === "eval" && onGlobal) push("third-party", n);
        if ((calleeName === "setTimeout" || calleeName === "setInterval") && constantString(args[0], consts) !== null) {
          push("third-party", n);
        }
        if (calleeName === "open" && calleeObj && !onGlobal) {
          // XMLHttpRequest.prototype.open(method, url)
          const url = constantString(args[1], consts);
          if (url !== null && ABSOLUTE_URL.test(url)) push("third-party", n, args[1].getText(sf));
        }
      } else {
        if (calleeName === "Image" || calleeName === "Audio") push("third-party", n);
        if (calleeName === "Function") push("third-party", n);
      }
      if (calleeName && NETWORK_CALLS.has(calleeName)) {
        const url = constantString(args[0], consts);
        if (calleeName === "importScripts" || (url !== null && ABSOLUTE_URL.test(url))) {
          push("third-party", n, args[0] ? args[0].getText(sf) : null);
        }
      }
    }

    // The adapter's `setAll` declared as a method or property.
    if ((ts.isMethodDeclaration(n) || ts.isPropertyAssignment(n)) && n.name.getText(sf) === "setAll") {
      push("cookie-write", n.name);
    }

    ts.forEachChild(n, visit);
  };
  visit(sf);

  return sites.sort((a, b) => a.pos - b.pos).map((s) => s.site);
}
