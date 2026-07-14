import { decode } from "html-entities";
import fs from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const sourceUploads = path.resolve(projectRoot, "../lifewatch.si/wp-content/uploads");
const outputUploads = path.resolve(projectRoot, "src/assets/uploads");
const postsDataPath = path.resolve(projectRoot, "src/_data/posts.json");
const postDir = path.resolve(projectRoot, "src/news");
const deprecatedPostAliasDir = path.resolve(projectRoot, "src/news-legacy");
const deprecatedProjectAliasDir = path.resolve(projectRoot, "src/projects");
const partnersDir = path.resolve(projectRoot, "src/partners");
const relatedProjectsDir = path.resolve(projectRoot, "src/related-projects");
const api = "https://lifewatch.si/wp-json/wp/v2";
const externalAssetAliases = new Map([
  [
    "https://www.lifewatch.eu/wp-content/uploads/2025/12/Subterranean-biodiversity.jpg",
    "/assets/uploads/Subterranean-biodiversity-768x378-1.jpg"
  ]
]);
const uploadAliases = new Map([
  ["LifeWatching_News-1.png", "LifeWatching_News.png"]
]);

const coreAssets = [
  "LW-SL.png",
  "LW-SI-white.svg",
  "LW-SI-OUTLINED.svg",
  "favicon.png",
  "2869-1024-Slovenia.png",
  "Datasets.svg",
  "researchsite-2.svg",
  "Services.svg",
  "Catalogue-of-Services.svg",
  "workflows-2.svg",
  "vres.svg",
  "244052508_4500346500025823_2728610394307214908_n-1024x390.jpeg",
  "LOGO-NIB-400x400-1.jpg",
  "logo.png",
  "Logo-Skocjan-Caves-11.jpg",
  "brd_logo-e1683824590273.jpg",
  "logo-ul-1.jpg",
  "download.png",
  "19_Univerza-NG-600x600-1.jpg",
  "famnit_logo_big.png",
  "LW-slovenia_screen3_SL.pdf",
  "LW-slovenia_ENG_screen3.pdf"
];

const curatedPages = ["about", "consortium", "projects", "contacts", "biodiversity-observatory-automation-wg"];

async function fetchAll(endpoint) {
  const items = [];
  let page = 1;
  let totalPages = 1;

  do {
    const separator = endpoint.includes("?") ? "&" : "?";
    const response = await fetch(`${endpoint}${separator}page=${page}`);
    if (!response.ok) {
      throw new Error(`Failed ${response.status} ${response.url}`);
    }

    items.push(...await response.json());
    totalPages = Number(response.headers.get("x-wp-totalpages")) || 1;
    page += 1;
  } while (page <= totalPages);

  return items;
}

function stripElementor(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/\s(?:class|data-[a-z0-9_-]+|style|id)="[^"]*"/gi, "")
    .replace(/<div>\s*<\/div>/gi, "")
    .replace(/<section>\s*<\/section>/gi, "")
    .replace(/\sdecoding="[^"]*"/gi, "")
    .replace(/\sloading="[^"]*"/gi, "")
    .replace(/\sfetchpriority="[^"]*"/gi, "")
    .replace(/<div>\s*/gi, "")
    .replace(/\s*<\/div>/gi, "")
    .replace(/<section>\s*/gi, "")
    .replace(/\s*<\/section>/gi, "")
    .replace(/<span>\s*<\/span>/gi, "")
    .replace(/<h([1-6])>\s*<h\1([^>]*)>([\s\S]*?)<\/h\1>\s*<\/h\1>/gi, "<h$1$2>$3</h$1>")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function plainExcerpt(html, length = 25) {
  const text = decode(html.replace(/<[^>]*>/g, ""))
    .replace(/\s*\[…]\s*$/, "")
    .replace(/[ \t\r\n]+/g, " ")
    .trim();
  return text.split(" ").slice(0, length).join(" ");
}

function frontMatter(data) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(data)) {
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push("---");
  return `${lines.join("\n")}\n`;
}

function localizeUrls(html) {
  let localized = html
    .replaceAll("https://lifewatch.si/wp-content/uploads/", "/assets/uploads/")
    .replaceAll("https://www.lifewatch.si/wp-content/uploads/", "/assets/uploads/");

  for (const [remote, local] of externalAssetAliases) {
    localized = localized.replaceAll(remote, local);
  }

  return localized;
}

function firstLocalImage(html) {
  return html.match(/<img[^>]+src="(\/assets\/uploads\/[^"]+)"/i)?.[1] || "";
}

async function localAssetExists(url) {
  if (!url.startsWith("/assets/uploads/")) return false;
  try {
    await fs.access(path.join(outputUploads, url.slice("/assets/uploads/".length)));
    return true;
  } catch {
    return false;
  }
}

function uploadPath(url) {
  try {
    const marker = "/wp-content/uploads/";
    const pathname = new URL(url).pathname;
    const index = pathname.indexOf(marker);
    if (index === -1) return decodeURIComponent(pathname.split("/").pop());
    return decodeURIComponent(pathname.slice(index + marker.length));
  } catch {
    return null;
  }
}

async function copyUpload(file) {
  if (!file) return false;
  const source = path.join(sourceUploads, file);
  const target = path.join(outputUploads, file);
  try {
    await fs.access(target);
    return true;
  } catch {
    // Copy only assets that have not already been reviewed or optimized locally.
  }
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
    return true;
  } catch {
    return false;
  }
}

async function copyReferencedUploads(html) {
  const matches = html.matchAll(/https?:\/\/(?:www\.)?lifewatch\.si\/wp-content\/uploads\/([^"')\s<]+)/g);
  for (const match of matches) {
    await copyUpload(decodeURIComponent(match[1]));
  }
}

async function migrateCollection(type, outputDir, urlBase, { preserveExisting = false } = {}) {
  const items = await fetchAll(`${api}/${type}?per_page=100&_fields=id,date,slug,title,content,featured_media,link`);
  await fs.mkdir(outputDir, { recursive: true });

  for (const item of items) {
    const outputPath = path.join(outputDir, `${item.slug}.njk`);
    if (preserveExisting) {
      try {
        await fs.access(outputPath);
        continue;
      } catch {
        // Generate newly added WordPress entries while retaining reviewed templates.
      }
    }

    const title = decode(item.title.rendered);
    const body = localizeUrls(stripElementor(item.content.rendered));
    await copyReferencedUploads(item.content.rendered);

    const file = `${frontMatter({
      layout: "page.njk",
      title,
      permalink: `/${urlBase}/${item.slug}/`
    })}${body}\n`;
    await fs.writeFile(outputPath, file);
  }
}

async function migratePosts(mediaById) {
  const posts = await fetchAll(`${api}/posts?per_page=100&_fields=id,date,slug,title,excerpt,content,featured_media`);
  await fs.mkdir(postDir, { recursive: true });

  let reviewedSummaries = [];
  try {
    reviewedSummaries = JSON.parse(await fs.readFile(postsDataPath, "utf8"));
  } catch {
    // The first migration has no reviewed summary data yet.
  }
  const reviewedBySlug = new Map(reviewedSummaries.map((post) => [post.slug, post]));

  const summaries = [];
  for (const post of posts) {
    const title = decode(post.title.rendered);
    const media = mediaById.get(post.featured_media);
    const body = localizeUrls(stripElementor(post.content.rendered));
    await copyReferencedUploads(post.content.rendered);

    const reviewed = reviewedBySlug.get(post.slug);
    const imageFile = media ? uploadPath(media.source_url) : null;
    const localImageFile = uploadAliases.get(imageFile) || imageFile;
    const copiedFeaturedImage = localImageFile ? await copyUpload(localImageFile) : false;
    const bodyImage = firstLocalImage(body);
    const image = copiedFeaturedImage
      ? `/assets/uploads/${localImageFile}`
      : await localAssetExists(bodyImage)
        ? bodyImage
        : reviewed?.image || "";

    summaries.push({
      id: post.id,
      date: post.date,
      slug: post.slug,
      title,
      excerpt: plainExcerpt(post.excerpt.rendered || post.content.rendered),
      archiveExcerpt: reviewed?.archiveExcerpt || `${plainExcerpt(post.content.rendered, 45)}...`,
      image
    });

    const file = `${frontMatter({
      layout: "post.njk",
      title,
      date: post.date,
      permalink: `/${post.slug}/`,
      image
    })}${body}\n`;
    await fs.writeFile(path.join(postDir, `${post.slug}.njk`), file);
  }

  await fs.writeFile(postsDataPath, `${JSON.stringify(summaries, null, 2)}\n`);
}

async function main() {
  await Promise.all([
    fs.rm(deprecatedPostAliasDir, { recursive: true, force: true }),
    fs.rm(deprecatedProjectAliasDir, { recursive: true, force: true })
  ]);

  await fs.mkdir(outputUploads, { recursive: true });
  for (const asset of coreAssets) {
    await copyUpload(asset);
  }

  const media = await fetchAll(`${api}/media?per_page=100&_fields=id,source_url,alt_text`);
  const mediaById = new Map(media.map((item) => [item.id, item]));

  await migratePosts(mediaById);
  await migrateCollection("partners", partnersDir, "partners", { preserveExisting: true });
  await migrateCollection("related-projects", relatedProjectsDir, "related-projects", { preserveExisting: true });
  console.log(`Keeping curated layout pages: ${curatedPages.join(", ")}`);

  console.log("Migration complete: generated posts, collections, and local uploads.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
