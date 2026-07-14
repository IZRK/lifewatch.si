import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import AxeBuilder from "@axe-core/playwright";
import { decode } from "html-entities";
import { chromium } from "playwright";

import redirects from "../src/_data/redirects.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const siteRoot = path.join(projectRoot, "_site");
const site = JSON.parse(fs.readFileSync(path.join(projectRoot, "src/_data/site.json"), "utf8"));
const metadataEndpoint = "https://metadata.izrk.zrc-sazu.si/srv/api/search/records/_search";
const viewportWidths = [320, 390, 560, 561, 599, 600, 767, 768, 1024, 1025, 1280, 1439, 1440];
const axeWidths = new Set([390, 1440]);
const failures = [];

const fail = (scope, detail) => failures.push(`${scope}: ${detail}`);

const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const file = path.join(directory, entry.name);
  return entry.isDirectory() ? walk(file) : [file];
});

const toPosix = (file) => file.split(path.sep).join("/");

const fileToRoute = (file) => {
  const relative = toPosix(path.relative(siteRoot, file));
  if (relative === "index.html") return "/";
  if (relative.endsWith("/index.html")) return `/${relative.slice(0, -"index.html".length)}`;
  return `/${relative}`;
};

const routeToFile = (route) => {
  const relative = route.replace(/^\/+/, "");
  return path.join(siteRoot, relative, "index.html");
};

const outputFileForPathname = (pathname) => {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  let output = path.join(siteRoot, decoded.replace(/^\/+/, ""));
  if (decoded.endsWith("/") || path.extname(decoded) === "") {
    output = path.join(output, "index.html");
  }
  return output;
};

const normalizeGeneratedPath = (pathname) => pathname
  .replace(/\/index\.html$/, "/")
  .replace(/^\/index\.html$/, "/");

if (!fs.existsSync(siteRoot)) {
  console.error("_site does not exist. Run npm run build before npm run audit.");
  process.exit(1);
}

const allOutputFiles = walk(siteRoot);
const htmlFiles = allOutputFiles.filter((file) => file.endsWith(".html"));
const htmlDocuments = htmlFiles.map((file) => ({
  file,
  route: fileToRoute(file),
  html: fs.readFileSync(file, "utf8"),
})).sort((a, b) => a.route.localeCompare(b.route));
const redirectDocuments = htmlDocuments.filter(({ html }) => /<meta[^>]+http-equiv=["']refresh["']/i.test(html));
const pageDocuments = htmlDocuments.filter(({ html }) => !/<meta[^>]+http-equiv=["']refresh["']/i.test(html));

const auditRedirects = () => {
  const configuredRoutes = new Set(redirects.map(({ from }) => from));
  const emittedRoutes = new Set(redirectDocuments.map(({ route }) => route));

  if (configuredRoutes.size !== redirects.length) fail("redirects", "configured routes are not unique");
  for (const route of configuredRoutes) {
    if (!emittedRoutes.has(route)) fail(route, "configured redirect document was not emitted");
  }
  for (const route of emittedRoutes) {
    if (!configuredRoutes.has(route)) fail(route, "unexpected redirect document was emitted");
  }

  for (const redirect of redirects) {
    const file = routeToFile(redirect.from);
    if (!fs.existsSync(file)) continue;
    const html = fs.readFileSync(file, "utf8");
    const refresh = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["']0;\s*url=([^"']+)["']/i)?.[1];
    const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1];
    const fallback = html.match(/This page has moved to\s*<a[^>]+href=["']([^"']+)["']/i)?.[1];
    const expectedCanonical = new URL(redirect.to, site.url).href;

    if (!/<meta[^>]+name=["']robots["'][^>]+content=["']noindex["']/i.test(html)) {
      fail(redirect.from, "redirect is missing robots noindex");
    }
    if (!refresh || decode(refresh) !== redirect.to) {
      fail(redirect.from, `refresh target does not match ${redirect.to}`);
    }
    if (!canonical || decode(canonical) !== expectedCanonical) {
      fail(redirect.from, `canonical target does not match ${expectedCanonical}`);
    }
    if (!fallback) {
      fail(redirect.from, "redirect is missing a fallback link");
    } else {
      const resolved = new URL(decode(fallback), new URL(redirect.from, site.url));
      if (redirect.to.startsWith("/")) {
        const expectedPath = new URL(redirect.to, site.url).pathname;
        if (normalizeGeneratedPath(resolved.pathname) !== expectedPath) {
          fail(redirect.from, `fallback link does not resolve to ${redirect.to}`);
        }
      } else if (resolved.href !== redirect.to) {
        fail(redirect.from, `fallback link does not resolve to ${redirect.to}`);
      }
    }

    if (redirect.to.startsWith("/")) {
      const target = outputFileForPathname(new URL(redirect.to, site.url).pathname);
      if (!target || !fs.existsSync(target)) fail(redirect.from, `local target is missing: ${redirect.to}`);
    }
  }
};

const collectHtmlReferences = (html) => {
  const references = [];
  for (const match of html.matchAll(/\b(?:href|src|poster)=["']([^"']*)["']/gi)) {
    references.push(decode(match[1]));
  }
  for (const match of html.matchAll(/\bsrcset=["']([^"']*)["']/gi)) {
    for (const candidate of decode(match[1]).split(",")) {
      const url = candidate.trim().split(/\s+/)[0];
      if (url) references.push(url);
    }
  }
  return references;
};

const assertLocalReference = (reference, baseUrl, scope) => {
  if (!reference || reference.startsWith("#")) return false;

  let resolved;
  try {
    resolved = new URL(reference, baseUrl);
  } catch {
    fail(scope, `invalid URL: ${reference}`);
    return false;
  }

  if (resolved.origin !== baseUrl.origin) return false;
  const output = outputFileForPathname(resolved.pathname);
  if (!output || !fs.existsSync(output)) fail(scope, `missing local reference: ${reference}`);
  return true;
};

const auditLocalReferences = () => {
  const auditOrigin = new URL("http://audit.local/");
  let referenceCount = 0;

  for (const { route, html } of htmlDocuments) {
    const baseUrl = new URL(route, auditOrigin);
    for (const reference of collectHtmlReferences(html)) {
      if (assertLocalReference(reference, baseUrl, route)) referenceCount += 1;
    }
  }

  for (const file of allOutputFiles.filter((output) => output.endsWith(".css"))) {
    const relative = toPosix(path.relative(siteRoot, file));
    const css = fs.readFileSync(file, "utf8");
    const baseUrl = new URL(relative, auditOrigin);
    for (const match of css.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
      const reference = match[2].trim();
      if (reference && !reference.startsWith("data:") && assertLocalReference(reference, baseUrl, relative)) {
        referenceCount += 1;
      }
    }
  }

  return referenceCount;
};

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

const startServer = async () => {
  const server = http.createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url, "http://audit.local");
      let pathname = decodeURIComponent(requestUrl.pathname);
      if (pathname.endsWith("/")) pathname += "index.html";
      let file = path.join(siteRoot, pathname.replace(/^\/+/, ""));
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");

      const relative = path.relative(siteRoot, file);
      if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(file)) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }

      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": contentTypes.get(path.extname(file).toLowerCase()) || "application/octet-stream",
      });
      if (request.method === "HEAD") response.end();
      else fs.createReadStream(file).pipe(response);
    } catch {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Bad request");
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return { server, origin: `http://127.0.0.1:${address.port}` };
};

const closeServer = (server) => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
});

const metadataBuckets = [
  ["Datasets", 101],
  ["Research sites", 202],
  ["Research equipment", 303],
  ["Services and databases", 404],
  ["Workflows and models", 505],
  ["vLabs", 606],
];

const fulfillMetadataRequest = async (route, onPost) => {
  const request = route.request();
  const headers = {
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-origin": "*",
  };

  if (request.method() === "OPTIONS") {
    await route.fulfill({ status: 204, headers });
    return;
  }

  if (request.method() === "POST") onPost?.(request);
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    headers,
    body: JSON.stringify({
      aggregations: {
        resourceTypes: {
          buckets: metadataBuckets.map(([key, doc_count]) => ({ key, doc_count })),
        },
      },
    }),
  });
};

const auditBrowser = async (browser, origin) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 900 }, reducedMotion: "reduce" });
  await context.route(metadataEndpoint, (route) => fulfillMetadataRequest(route));
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  let runtimeIssues = [];
  let axeChecks = 0;
  let viewportChecks = 0;

  page.on("console", (message) => {
    if (message.type() === "error") runtimeIssues.push(`console error: ${message.text()}`);
  });
  page.on("pageerror", (error) => runtimeIssues.push(`page error: ${error.message}`));

  for (const width of viewportWidths) {
    await page.setViewportSize({ width, height: 900 });

    for (const { route } of pageDocuments) {
      runtimeIssues = [];
      const scope = `${width}px ${route}`;

      try {
        const response = await page.goto(`${origin}${route}`, { waitUntil: "domcontentloaded", timeout: 15_000 });
        if (!response || response.status() >= 400) fail(scope, `navigation returned ${response?.status() ?? "no response"}`);

        await page.evaluate(() => document.fonts.ready.then(() => true));
        await page.locator("img").evaluateAll((images) => images.forEach((image) => { image.loading = "eager"; }));
        await page.waitForFunction(() => [...document.images].every((image) => image.complete), null, { timeout: 8_000 });

        const state = await page.evaluate(() => ({
          brokenImages: [...document.images]
            .filter((image) => image.naturalWidth === 0)
            .map((image) => image.getAttribute("src")),
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        }));

        if (state.overflow > 1) fail(scope, `horizontal overflow is ${state.overflow}px`);
        if (state.brokenImages.length) fail(scope, `broken images: ${state.brokenImages.join(", ")}`);

        if (axeWidths.has(width)) {
          const { violations } = await new AxeBuilder({ page }).analyze();
          axeChecks += 1;
          for (const violation of violations) {
            fail(scope, `axe ${violation.id} (${violation.nodes.length} nodes)`);
          }
        }

        if (route === "/" && (width === 1439 || width === 1440)) {
          const shell = await page.evaluate(() => ({
            header: getComputedStyle(document.querySelector(".site-header")).display,
            sidebar: getComputedStyle(document.querySelector(".sidebar-nav")).display,
          }));
          const desktop = width === 1440;
          if ((shell.header === "none") !== desktop) fail(scope, "header visibility does not match the shell breakpoint");
          if ((shell.sidebar !== "none") !== desktop) fail(scope, "sidebar visibility does not match the shell breakpoint");
        }

        for (const issue of new Set(runtimeIssues)) fail(scope, issue);
        viewportChecks += 1;
      } catch (error) {
        fail(scope, error.message);
      }
    }

    console.log(`Checked ${pageDocuments.length} pages at ${width}px`);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  const toggle = page.locator(".menu-toggle");
  await toggle.click();
  if (await toggle.getAttribute("aria-expanded") !== "true") fail("mobile menu", "toggle did not open the navigation");
  if (!await page.locator("#site-nav").evaluate((navigation) => navigation.classList.contains("is-open"))) {
    fail("mobile menu", "navigation is missing its open state");
  }
  if (!await page.locator("#site-nav").evaluate((navigation) => {
    const styles = getComputedStyle(navigation);
    return styles.display !== "none" && styles.visibility !== "hidden" && navigation.getBoundingClientRect().height > 0;
  })) {
    fail("mobile menu", "navigation is not visible after opening");
  }
  await page.keyboard.press("Escape");
  if (await toggle.getAttribute("aria-expanded") !== "false") fail("mobile menu", "Escape did not close the navigation");
  if (await page.locator("#site-nav").evaluate((navigation) => getComputedStyle(navigation).display !== "none")) {
    fail("mobile menu", "navigation remains visible after Escape");
  }
  if (!await toggle.evaluate((element) => document.activeElement === element)) {
    fail("mobile menu", "focus did not return to the toggle after Escape");
  }

  await context.close();
  return { axeChecks, viewportChecks };
};

const auditCounters = async (browser, origin) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "no-preference" });
  let postCount = 0;
  let requestBody;

  await context.addInitScript(() => {
    const requestFrame = window.requestAnimationFrame.bind(window);
    window.__auditAnimationFrames = 0;
    window.requestAnimationFrame = (callback) => requestFrame((timestamp) => {
      window.__auditAnimationFrames += 1;
      callback(timestamp);
    });
  });

  await context.route(metadataEndpoint, (route) => fulfillMetadataRequest(route, (request) => {
    postCount += 1;
    try {
      requestBody = JSON.parse(request.postData() || "null");
    } catch {
      requestBody = null;
    }
  }));

  const page = await context.newPage();
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await page.locator(".resources").scrollIntoViewIfNeeded();
  const expected = metadataBuckets.map(([, count]) => String(count));
  await page.waitForFunction((values) => {
    const current = [...document.querySelectorAll(".resource-count")].map((element) => element.textContent.trim());
    return JSON.stringify(current) === JSON.stringify(values);
  }, expected, { timeout: 10_000 });

  if (postCount !== 1) fail("metadata counters", `expected one POST request, received ${postCount}`);
  const must = requestBody?.query?.bool?.must || [];
  const categoryQuery = must.find((clause) => clause.query_string)?.query_string?.query || "";
  const templateFilter = must.find((clause) => clause.terms?.isTemplate)?.terms?.isTemplate || [];
  if (
    !requestBody
    || requestBody.size !== 0
    || !requestBody.aggs?.resourceTypes
    || !categoryQuery.includes('cat:"RI-SI-LifeWatch"')
    || !categoryQuery.includes('cat:"lifewatch"')
    || !templateFilter.includes("n")
  ) {
    fail("metadata counters", "GeoNetwork request body is missing the aggregation query");
  }
  const animationFrames = await page.evaluate(() => window.__auditAnimationFrames);
  if (animationFrames < metadataBuckets.length * 2) {
    fail("metadata counters", `animated path used only ${animationFrames} requestAnimationFrame callbacks`);
  }

  await context.close();
};

auditRedirects();
const localReferences = auditLocalReferences();
const { server, origin } = await startServer();
let browser;

try {
  browser = await chromium.launch({ headless: true });
  const browserResults = await auditBrowser(browser, origin);
  await auditCounters(browser, origin);

  console.log(
    `Audited ${pageDocuments.length} pages, ${redirects.length} redirects, `
    + `${localReferences} local references, ${browserResults.viewportChecks} viewport checks, `
    + `and ${browserResults.axeChecks} axe checks.`,
  );
} catch (error) {
  fail("audit", error.stack || error.message);
} finally {
  await browser?.close();
  await closeServer(server);
}

if (failures.length) {
  console.error(`\nAudit failed with ${failures.length} issue${failures.length === 1 ? "" : "s"}:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Audit passed with no failures.");
}
