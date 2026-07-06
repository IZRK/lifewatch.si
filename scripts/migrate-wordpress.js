import { decode } from "html-entities";
import fs from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const sourceUploads = path.resolve(projectRoot, "../lifewatch.si/wp-content/uploads");
const outputUploads = path.resolve(projectRoot, "src/assets/uploads");
const postsDataPath = path.resolve(projectRoot, "src/_data/posts.json");
const postDir = path.resolve(projectRoot, "src/news");
const pageDir = path.resolve(projectRoot, "src");
const api = "https://lifewatch.si/wp-json/wp/v2";

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
  "ZRCSAZU_Institut-za-raziskovanje-krasa_logotip_CMYK-1024x363-1-1.jpg",
  "LOGO-NIB-400x400-1.jpg",
  "logo.png",
  "logo-500x114.png",
  "Logo-Skocjan-Caves-11.jpg",
  "brd_logo-e1683824590273.jpg",
  "logo-ul-1.jpg",
  "download.png",
  "19_Univerza-NG-600x600-1.jpg",
  "famnit_logo_big.png"
];

const pageIds = {
  about: 4223,
  consortium: 10058,
  projects: 10053,
  contacts: 6923,
  "biodiversity-observatory-automation-wg": 17397
};

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed ${response.status} ${url}`);
  }
  return response.json();
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
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function plainExcerpt(html, length = 220) {
  const text = decode(html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
  return text.length > length ? `${text.slice(0, length).trim()}...` : text;
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
  return html
    .replaceAll("https://lifewatch.si/wp-content/uploads/", "/assets/uploads/")
    .replaceAll("https://www.lifewatch.si/wp-content/uploads/", "/assets/uploads/");
}

function uploadFilename(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop());
  } catch {
    return null;
  }
}

async function copyUpload(file) {
  if (!file) return false;
  const source = path.join(sourceUploads, file);
  const target = path.join(outputUploads, file);
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

async function migratePosts(mediaById) {
  const posts = await fetchJson(`${api}/posts?per_page=100&_fields=id,date,slug,title,excerpt,content,featured_media`);
  await fs.mkdir(postDir, { recursive: true });

  const summaries = [];
  for (const post of posts) {
    const title = decode(post.title.rendered);
    const media = mediaById.get(post.featured_media);
    const imageFile = media ? uploadFilename(media.source_url) : null;
    if (imageFile) await copyUpload(imageFile);

    const body = localizeUrls(stripElementor(post.content.rendered));
    await copyReferencedUploads(post.content.rendered);

    summaries.push({
      id: post.id,
      date: post.date,
      slug: post.slug,
      title,
      excerpt: plainExcerpt(post.excerpt.rendered || post.content.rendered),
      image: imageFile ? `/assets/uploads/${imageFile}` : ""
    });

    const file = `${frontMatter({
      layout: "post.njk",
      title,
      date: post.date,
      permalink: `/news/${post.slug}/`,
      image: imageFile ? `/assets/uploads/${imageFile}` : ""
    })}${body}\n`;
    await fs.writeFile(path.join(postDir, `${post.slug}.njk`), file);
  }

  await fs.writeFile(postsDataPath, `${JSON.stringify(summaries, null, 2)}\n`);
}

async function migratePages() {
  for (const [slug, id] of Object.entries(pageIds)) {
    const page = await fetchJson(`${api}/pages/${id}?_fields=id,slug,title,content`);
    const title = decode(page.title.rendered);
    let body = localizeUrls(stripElementor(page.content.rendered));
    await copyReferencedUploads(page.content.rendered);

    if (!body || body.length < 80) {
      body = `<p>${title} content should be reviewed against the original WordPress page. The static route is in place for navigation continuity.</p>`;
    }

    const file = `${frontMatter({
      layout: "page.njk",
      title,
      permalink: `/${slug}/`
    })}${body}\n`;
    await fs.writeFile(path.join(pageDir, `${slug}.njk`), file);
  }

  await writeProjectPages();
}

async function writeProjectPages() {
  const projectsRoot = path.join(pageDir, "projects");
  await fs.mkdir(projectsRoot, { recursive: true });
  const projects = [
    ["ri-si-lifewatch", "RI-SI-LifeWatch", "RI-SI-LifeWatch strengthened Slovenian participation in the LifeWatch ERIC infrastructure and supported national biodiversity and ecosystem research services."],
    ["envri-fair", "ENVRI-FAIR", "ENVRI-FAIR connected environmental research infrastructures through FAIR data services and shared standards."],
    ["open-earth-monitor", "Open-Earth-Monitor", "Open-Earth-Monitor supports open-source environmental cyberinfrastructure and monitoring workflows."]
  ];

  for (const [slug, title, text] of projects) {
    const file = `${frontMatter({
      layout: "page.njk",
      title,
      permalink: `/projects/${slug}/`
    })}<p>${text}</p>\n`;
    await fs.writeFile(path.join(projectsRoot, `${slug}.njk`), file);
  }
}

async function main() {
  await fs.mkdir(outputUploads, { recursive: true });
  for (const asset of coreAssets) {
    await copyUpload(asset);
  }

  const media = await fetchJson(`${api}/media?per_page=100&_fields=id,source_url,alt_text`);
  const mediaById = new Map(media.map((item) => [item.id, item]));

  await migratePosts(mediaById);
  await migratePages();

  console.log("Migration complete: generated posts, pages, and local uploads.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
