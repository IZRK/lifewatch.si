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
const representativesRoute = "/representatives-of-the-slovenian-lifewatch-consortium-at-the-lifewatch-eric-bees-conference-in-heraklion/";
const viewportWidths = [320, 390, 560, 561, 599, 600, 767, 768, 1024, 1025, 1280, 1439, 1440];
const axeWidths = new Set([390, 1440]);
const failures = [];

const fail = (scope, detail) => failures.push(`${scope}: ${detail}`);
const withinPixels = (actual, expected, tolerance = 0.5) => Math.abs(actual - expected) <= tolerance;

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
    for (const match of html.matchAll(/\bhref=["']([^"']*)["']/gi)) {
      const reference = decode(match[1]);
      if (reference.startsWith("#") || reference.startsWith("?")) continue;

      try {
        const resolved = new URL(reference, baseUrl);
        if (resolved.origin === auditOrigin.origin && resolved.pathname.endsWith(".html")) {
          fail(route, `local link exposes an .html filename: ${reference}`);
        }
      } catch {
        // Invalid references are reported by assertLocalReference below.
      }
    }
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

        if (route === "/" && (width === 1024 || width === 1025)) {
          const shell = await page.evaluate(() => ({
            header: getComputedStyle(document.querySelector(".site-header")).display,
            sidebar: getComputedStyle(document.querySelector(".sidebar-nav")).display,
          }));
          const desktop = width === 1025;
          if ((shell.header === "none") !== desktop) fail(scope, "header visibility does not match the shell breakpoint");
          if ((shell.sidebar !== "none") !== desktop) fail(scope, "sidebar visibility does not match the shell breakpoint");
        }

        if (width === 390) {
          const mobileTitle = page.locator(".page-titlebar h1").first();
          if (await mobileTitle.count()) {
            const titleType = await mobileTitle.evaluate((title) => ({
              fontSize: getComputedStyle(title).fontSize,
              lineHeight: getComputedStyle(title).lineHeight,
            }));
            if (titleType.fontSize !== "41px" || titleType.lineHeight !== "41px") {
              fail(scope, `mobile page title is ${titleType.fontSize}/${titleType.lineHeight}, expected 41px/41px`);
            }
          }
        }

        if (route === "/biodiversity-observatory-automation-wg/" && width === 1024) {
          const wg = await page.evaluate(() => {
            const button = document.querySelector(".wg-hero .button");
            const intro = document.querySelector(".wg-intro");
            const buttonRect = button?.getBoundingClientRect();
            const introChildren = [...(intro?.children || [])].map((child) => {
              const rect = child.getBoundingClientRect();
              return { left: rect.left, top: rect.top, right: rect.right, width: rect.width };
            });
            return {
              button: buttonRect ? { width: buttonRect.width, height: buttonRect.height } : null,
              introDisplay: intro ? getComputedStyle(intro).display : null,
              introColumns: intro ? getComputedStyle(intro).gridTemplateColumns : null,
              introChildren,
            };
          });

          if (!wg.button) {
            fail(scope, "WG join button is missing");
          } else if (!withinPixels(wg.button.width, 138.64, 0.2) || !withinPixels(wg.button.height, 39, 0.1)) {
            fail(scope, `WG join button is ${wg.button.width.toFixed(2)}x${wg.button.height.toFixed(2)}, expected 138.64x39`);
          }
          if (
            wg.introDisplay !== "grid"
            || (wg.introColumns || "").split(/\s+/).filter(Boolean).length !== 2
            || wg.introChildren.length !== 2
            || !withinPixels(wg.introChildren[0].top, wg.introChildren[1].top, 0.1)
            || wg.introChildren[1].left < wg.introChildren[0].right
          ) {
            fail(scope, "WG intro is not a two-column grid at 1024px");
          }
        }

        if (width === 390 || width === 1440) {
          const postDetail = await page.evaluate(() => {
            const grid = document.querySelector(".post-detail-columns");
            if (!grid) return null;
            return {
              display: getComputedStyle(grid).display,
              columns: getComputedStyle(grid).gridTemplateColumns.split(/\s+/).filter(Boolean).length,
              children: [...grid.children].map((child) => {
                const rect = child.getBoundingClientRect();
                return {
                  left: rect.left,
                  top: rect.top,
                  right: rect.right,
                  bottom: rect.bottom,
                  width: rect.width,
                };
              }),
            };
          });

          if (postDetail) {
            if (postDetail.display !== "grid" || postDetail.children.length !== 2) {
              fail(scope, "news detail is missing its two-part grid");
            } else if (width === 1440) {
              const [first, second] = postDetail.children;
              if (
                postDetail.columns !== 2
                || !withinPixels(first.top, second.top, 0.1)
                || second.left < first.right
              ) {
                fail(scope, "news detail is not a non-overlapping two-column desktop layout");
              }
            } else {
              const [first, second] = postDetail.children;
              if (
                postDetail.columns !== 1
                || !withinPixels(first.left, second.left, 0.1)
                || !withinPixels(first.width, second.width, 0.1)
                || second.top < first.bottom
              ) {
                fail(scope, "news detail does not stack without overlap on mobile");
              }
            }
          }
        }

        if (route === "/partners/nib/" && [390, 768, 1024, 1025, 1440].includes(width)) {
          const nib = await page.evaluate(() => {
            const intro = document.querySelector('.detail-content > img[src$="/logo.png"] + p');
            const research = intro?.nextElementSibling;
            const publications = document.querySelector(".nib-publications");
            const introRect = intro?.getBoundingClientRect();
            const researchRect = research?.getBoundingClientRect();
            return {
              introBottom: introRect?.bottom,
              researchTop: researchRect?.top,
              publicationDisplay: publications ? getComputedStyle(publications).display : null,
              publicationColumns: publications
                ? getComputedStyle(publications).gridTemplateColumns.split(/\s+/).filter(Boolean).length
                : 0,
            };
          });
          const expectedColumns = width >= 768 ? 2 : 1;
          if (
            nib.introBottom === undefined
            || nib.researchTop === undefined
            || nib.researchTop < nib.introBottom
          ) {
            fail(scope, "NIB introduction overlaps the Research section");
          }
          if (nib.publicationDisplay !== "grid" || nib.publicationColumns !== expectedColumns) {
            fail(scope, `NIB publications use ${nib.publicationColumns} columns, expected ${expectedColumns}`);
          }
        }

        if (route === representativesRoute && (width === 390 || width === 1440)) {
          const representatives = await page.evaluate(() => {
            const grid = document.querySelector(".post-detail-columns--representatives");
            if (!grid) return null;
            const columns = [...grid.children].map((column) => {
              const rect = column.getBoundingClientRect();
              const media = [...column.querySelectorAll(".post-detail-media img")].map((image) => {
                const mediaRect = image.getBoundingClientRect();
                return { width: mediaRect.width, left: mediaRect.left, right: mediaRect.right };
              });
              return {
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                width: rect.width,
                media,
              };
            });
            return {
              display: getComputedStyle(grid).display,
              gridTemplateColumns: getComputedStyle(grid).gridTemplateColumns,
              columns,
            };
          });

          if (!representatives || representatives.columns.length !== 2) {
            fail(scope, "representatives detail is missing its two content columns");
          } else if (width === 1440) {
            const [first, second] = representatives.columns;
            if (
              representatives.display !== "grid"
              || representatives.gridTemplateColumns.split(/\s+/).filter(Boolean).length !== 2
              || !withinPixels(first.top, second.top, 0.1)
              || second.left < first.right
              || !withinPixels(first.width, second.width, 0.1)
            ) {
              fail(scope, "representatives detail is not a two-column desktop layout");
            }
          } else {
            const [first, second] = representatives.columns;
            const mediaIsFullWidth = representatives.columns.every((column) => (
              column.media.length > 0
              && column.media.every((media) => withinPixels(media.width, column.width, 1))
            ));
            if (
              representatives.display !== "grid"
              || representatives.gridTemplateColumns.split(/\s+/).filter(Boolean).length !== 1
              || !withinPixels(first.left, second.left, 0.1)
              || !withinPixels(first.width, second.width, 0.1)
              || second.top < first.bottom
              || !mediaIsFullWidth
            ) {
              fail(scope, "representatives detail does not stack with full-width media on mobile");
            }
          }
        }

        if (route === "/consortium/" && (width === 390 || width === 1440)) {
          const consortium = await page.evaluate(() => {
            const grid = document.querySelector(".consortium-page .partner-grid");
            const footer = document.querySelector(".site-footer");
            const cards = [...document.querySelectorAll(".consortium-page .partner-card")];
            const gridRect = grid?.getBoundingClientRect();
            const footerRect = footer?.getBoundingClientRect();
            return {
              grid: gridRect ? {
                left: gridRect.left,
                top: gridRect.top,
                width: gridRect.width,
                height: gridRect.height,
              } : null,
              footerTop: footerRect?.top,
              cards: cards.map((card) => card.getBoundingClientRect().height),
              linkDecorations: cards.map((card) => getComputedStyle(card).textDecorationLine),
            };
          });

          if (!consortium.grid || consortium.cards.length !== 10 || consortium.linkDecorations.length !== 10) {
            fail(scope, "Consortium partner grid is incomplete");
          } else if (consortium.linkDecorations.some((decoration) => decoration !== "none")) {
            fail(scope, "Consortium partner links are underlined");
          } else if (width === 390) {
            if (
              !withinPixels(consortium.grid.left, 10, 0.1)
              || !withinPixels(consortium.grid.top, 588.02, 0.1)
              || !withinPixels(consortium.grid.width, 370, 0.1)
              || !withinPixels(consortium.grid.height, 2819.06, 0.1)
              || consortium.cards.some((height) => !withinPixels(height, 250.41, 0.1))
              || !withinPixels(consortium.footerTop, 3471.67, 0.1)
            ) {
              fail(scope, "mobile Consortium cards or footer do not match the live geometry");
            }
          } else if (
            !withinPixels(consortium.grid.left, 310, 0.1)
            || !withinPixels(consortium.grid.top, 513.13, 0.1)
            || !withinPixels(consortium.grid.width, 1120, 0.1)
            || !withinPixels(consortium.grid.height, 491.03, 0.1)
            || consortium.cards.slice(0, 5).some((height) => !withinPixels(height, 238.22, 0.1))
            || consortium.cards.slice(5).some((height) => !withinPixels(height, 217.81, 0.1))
            || !withinPixels(consortium.footerTop, 1064.45, 0.1)
          ) {
            fail(scope, "desktop Consortium rows or footer do not match the live geometry");
          }

          const firstPartner = page.locator(".consortium-page .partner-card").first();
          await firstPartner.hover();
          if (await firstPartner.evaluate((card) => getComputedStyle(card).textDecorationLine) !== "none") {
            fail(scope, "Consortium partner link becomes underlined on hover");
          }
        }

        if (route === "/communications/news/" && (width === 390 || width === 1440)) {
          const newsControls = await page.evaluate(() => [...document.querySelectorAll(".archive-card")].map((card) => {
            const button = card.querySelector(".archive-card-actions .button");
            const socialLinks = [...card.querySelectorAll(".share-links a")];
            const buttonRect = button?.getBoundingClientRect();
            return {
              button: buttonRect ? {
                width: buttonRect.width,
                height: buttonRect.height,
                scrollHeight: button.scrollHeight,
                whiteSpace: getComputedStyle(button).whiteSpace,
              } : null,
              socials: socialLinks.map((link) => {
                const rect = link.getBoundingClientRect();
                return { left: rect.left, right: rect.right, width: rect.width, height: rect.height };
              }),
            };
          }));

          if (!newsControls.length) fail(scope, "news archive cards are missing");
          for (const [index, controls] of newsControls.entries()) {
            if (
              !controls.button
              || !withinPixels(controls.button.width, 97, 0.1)
              || !withinPixels(controls.button.height, 40, 0.1)
              || controls.button.scrollHeight > controls.button.height
              || controls.button.whiteSpace !== "nowrap"
            ) {
              fail(scope, `news card ${index + 1} has a broken Read more button`);
            }
            if (
              controls.socials.length !== 3
              || controls.socials.some((social) => (
                !withinPixels(social.width, 32, 0.1) || !withinPixels(social.height, 32, 0.1)
              ))
              || controls.socials.slice(1).some((social, socialIndex) => (
                !withinPixels(social.left - controls.socials[socialIndex].right, 6, 0.1)
              ))
            ) {
              fail(scope, `news card ${index + 1} social buttons are oversized or touching`);
            }
          }
        }

        if (route === "/" && width === 1440) {
          const footer = await page.evaluate(() => {
            const element = document.querySelector(".site-footer");
            const logo = document.querySelector(".footer-logo");
            const social = document.querySelector(".footer-social-link");
            const rect = element?.getBoundingClientRect();
            const logoRect = logo?.getBoundingClientRect();
            const socialRect = social?.getBoundingClientRect();
            return {
              rect: rect ? { left: rect.left, width: rect.width, height: rect.height } : null,
              columns: [...(element?.children || [])].map((column) => column.getBoundingClientRect().width),
              logo: logoRect ? { width: logoRect.width, height: logoRect.height } : null,
              links: [...document.querySelectorAll(".footer-links a")].map((link) => ({
                height: link.getBoundingClientRect().height,
                fontSize: getComputedStyle(link).fontSize,
                lineHeight: getComputedStyle(link).lineHeight,
              })),
              social: socialRect ? {
                width: socialRect.width,
                height: socialRect.height,
                href: social.href,
                label: social.getAttribute("aria-label"),
              } : null,
            };
          });

          if (
            !footer.rect
            || !withinPixels(footer.rect.left, 300, 0.1)
            || !withinPixels(footer.rect.width, 1140, 0.1)
            || !withinPixels(footer.rect.height, 300, 0.1)
            || footer.columns.length !== 4
            || footer.columns.some((columnWidth) => !withinPixels(columnWidth, 280, 0.1))
          ) {
            fail(scope, "desktop footer is not 1140x300 with four 280px columns after the sidebar");
          }
          if (
            !footer.logo
            || !withinPixels(footer.logo.width, 168, 0.1)
            || !withinPixels(footer.logo.height, 79.81, 0.2)
          ) {
            fail(scope, "desktop footer logo is not 168x79.81");
          }
          if (
            footer.links.length !== 3
            || footer.links.some((link) => (
              !withinPixels(link.height, 26, 0.1)
              || link.fontSize !== "17px"
              || link.lineHeight !== "20px"
            ))
          ) {
            fail(scope, "desktop footer links do not use 26px rows with 17px/20px type");
          }
          if (
            !footer.social
            || !withinPixels(footer.social.width, 50, 0.1)
            || !withinPixels(footer.social.height, 50, 0.1)
            || footer.social.href !== "https://bsky.app/profile/lifewatch.si"
            || footer.social.label !== "LifeWatch Slovenia on Bluesky"
          ) {
            fail(scope, "desktop footer Bluesky control is incorrect");
          }
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
  const mobileMenuAxe = await new AxeBuilder({ page }).analyze();
  axeChecks += 1;
  for (const violation of mobileMenuAxe.violations) {
    fail("mobile menu open", `axe ${violation.id} (${violation.nodes.length} nodes)`);
  }
  await page.keyboard.press("Escape");
  if (await toggle.getAttribute("aria-expanded") !== "false") fail("mobile menu", "Escape did not close the navigation");
  if (await page.locator("#site-nav").evaluate((navigation) => getComputedStyle(navigation).display !== "none")) {
    fail("mobile menu", "navigation remains visible after Escape");
  }
  if (!await toggle.evaluate((element) => document.activeElement === element)) {
    fail("mobile menu", "focus did not return to the toggle after Escape");
  }

  const sidebarItems = () => page.locator(".side-menu-item").filter({ has: page.locator(".side-submenu-toggle") });
  const sidebarItem = (label) => page.locator(".side-menu-item").filter({
    has: page.getByRole("link", { name: label, exact: true }),
  });
  const sidebarState = (item) => item.evaluate((element) => {
    const button = element.querySelector(".side-submenu-toggle");
    const submenu = element.querySelector(".side-submenu");
    return {
      expanded: button?.getAttribute("aria-expanded"),
      openClass: element.classList.contains("is-open"),
      visible: submenu ? getComputedStyle(submenu).display !== "none" : false,
      icon: button?.querySelector(".side-submenu-toggle-icon")?.textContent?.trim(),
      controls: button?.getAttribute("aria-controls"),
      submenuId: submenu?.id,
    };
  });
  const assertSidebarState = async (scope, item, open) => {
    const state = await sidebarState(item);
    const expectedExpanded = String(open);
    const expectedIcon = open ? "-" : "+";
    if (
      state.expanded !== expectedExpanded
      || state.openClass !== open
      || state.visible !== open
      || state.icon !== expectedIcon
      || !state.controls
      || state.controls !== state.submenuId
    ) {
      fail(scope, `submenu state is inconsistent: ${JSON.stringify(state)}`);
    }
  };
  const auditClosedSidebarItems = async (scope) => {
    const items = sidebarItems();
    const count = await items.count();
    if (!count) fail(scope, "no desktop submenu controls were found");

    for (let index = 0; index < count; index += 1) {
      const item = items.nth(index);
      const parentLink = item.locator("a.has-children");
      const toggle = item.locator(".side-submenu-toggle");
      const label = (await parentLink.textContent())?.trim() || `submenu ${index + 1}`;

      await assertSidebarState(`${scope} ${label} initial`, item, false);
      await parentLink.hover();
      await assertSidebarState(`${scope} ${label} parent hover`, item, false);
      await toggle.hover();
      await assertSidebarState(`${scope} ${label} toggle hover`, item, false);
    }
  };

  for (const width of [1025, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await auditClosedSidebarItems(`sidebar ${width}px home`);

    const consortiumItem = sidebarItem("Consortium");
    const consortiumToggle = consortiumItem.locator(".side-submenu-toggle");
    if (await consortiumItem.count() !== 1) {
      fail(`sidebar ${width}px home`, "Consortium submenu control is missing");
    } else {
      await consortiumToggle.focus();
      await page.keyboard.press("Enter");
      await assertSidebarState(`sidebar ${width}px keyboard open`, consortiumItem, true);
      await consortiumToggle.click();
      await assertSidebarState(`sidebar ${width}px click close`, consortiumItem, false);
      await consortiumToggle.click();
      await assertSidebarState(`sidebar ${width}px click open`, consortiumItem, true);
      if (width === 1025) {
        const desktopMenuAxe = await new AxeBuilder({ page }).analyze();
        axeChecks += 1;
        for (const violation of desktopMenuAxe.violations) {
          fail("desktop submenu open", `axe ${violation.id} (${violation.nodes.length} nodes)`);
        }
      }
      await consortiumToggle.click();
      await assertSidebarState(`sidebar ${width}px second click close`, consortiumItem, false);
    }

    await page.goto(`${origin}/consortium/`, { waitUntil: "domcontentloaded" });
    await auditClosedSidebarItems(`sidebar ${width}px active Consortium`);

    await page.goto(`${origin}/partners/izrk/`, { waitUntil: "domcontentloaded" });
    await auditClosedSidebarItems(`sidebar ${width}px active partner child`);

    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    const homeConsortiumItem = sidebarItem("Consortium");
    const projectsItem = sidebarItem("Projects");
    await homeConsortiumItem.locator(".side-submenu-toggle").click();
    await projectsItem.locator(".side-submenu-toggle").click();
    await assertSidebarState(`sidebar ${width}px independent Consortium`, homeConsortiumItem, true);
    await assertSidebarState(`sidebar ${width}px independent Projects`, projectsItem, true);
  }

  await page.setViewportSize({ width: 1025, height: 600 });
  await page.goto(`${origin}/partners/izrk/`, { waitUntil: "domcontentloaded" });
  const shortConsortiumItem = sidebarItem("Consortium");
  await shortConsortiumItem.locator(".side-submenu-toggle").click();
  const sidebarScroll = await page.locator(".sidebar-nav").evaluate((navigation) => {
    navigation.scrollTop = navigation.scrollHeight;
    const contacts = [...navigation.querySelectorAll(".side-menu > .side-menu-item > a")]
      .find((link) => link.textContent.trim().toUpperCase() === "CONTACTS");
    const navigationRect = navigation.getBoundingClientRect();
    const contactsRect = contacts?.getBoundingClientRect();
    return {
      overflowY: getComputedStyle(navigation).overflowY,
      clientHeight: navigation.clientHeight,
      scrollHeight: navigation.scrollHeight,
      scrollTop: navigation.scrollTop,
      contactsBottom: contactsRect?.bottom,
      navigationBottom: navigationRect.bottom,
    };
  });
  if (
    !["auto", "scroll"].includes(sidebarScroll.overflowY)
    || sidebarScroll.scrollHeight <= sidebarScroll.clientHeight
    || sidebarScroll.scrollTop <= 0
    || sidebarScroll.contactsBottom === undefined
    || sidebarScroll.contactsBottom > sidebarScroll.navigationBottom + 0.1
  ) {
    fail("sidebar 1025x600", `expanded navigation cannot reach its final link: ${JSON.stringify(sidebarScroll)}`);
  }

  await page.setViewportSize({ width: 3840, height: 2160 });
  await page.goto(`${origin}/contacts/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => document.fonts.ready.then(() => true));
  const fourKFooter = await page.evaluate(() => {
    const footer = document.querySelector(".site-footer")?.getBoundingClientRect();
    return {
      footerBottom: footer?.bottom,
      viewportHeight: window.innerHeight,
      documentHeight: document.documentElement.scrollHeight,
    };
  });
  if (
    fourKFooter.footerBottom === undefined
    || !withinPixels(fourKFooter.footerBottom, fourKFooter.viewportHeight, 0.1)
    || !withinPixels(fourKFooter.documentHeight, fourKFooter.viewportHeight, 0.1)
  ) {
    fail("contacts 3840x2160", `footer does not reach the viewport bottom: ${JSON.stringify(fourKFooter)}`);
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
