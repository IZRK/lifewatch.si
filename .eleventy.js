import path from "node:path";

export default function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy({ "src/assets": "assets" });

  eleventyConfig.addFilter("readableDate", (value) => {
    return new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(new Date(value));
  });

  eleventyConfig.addFilter("wordpressDate", (value) => {
    const date = new Date(value);
    const monthAndYear = new Intl.DateTimeFormat("en-GB", {
      month: "long",
      year: "numeric",
    }).format(date);
    return `${date.getDate()}. ${monthAndYear}`;
  });

  eleventyConfig.addFilter("limit", (items, count) => {
    return Array.isArray(items) ? items.slice(0, count) : items;
  });

  eleventyConfig.addFilter("absoluteUrl", (value, base) => {
    try {
      return new URL(value, base).href;
    } catch {
      return value;
    }
  });

  eleventyConfig.addTransform("relative-local-urls", function (content) {
    if (!this.page.outputPath || !this.page.outputPath.endsWith(".html")) {
      return content;
    }

    const outputRoot = path.resolve("_site");
    const currentDir = path.dirname(path.resolve(this.page.outputPath));

    const toRelative = (url) => {
      const match = url.match(/^([^?#]+)([?#].*)?$/);
      if (!match || !match[1].startsWith("/") || match[1].startsWith("//")) {
        return url;
      }

      const pathname = match[1];
      const suffix = match[2] || "";
      const hasExtension = path.extname(pathname) !== "";
      const target = hasExtension
        ? path.join(outputRoot, pathname)
        : path.join(outputRoot, pathname, "index.html");
      let relative = path.relative(currentDir, target).replaceAll(path.sep, "/");

      if (!relative.startsWith(".")) {
        relative = `./${relative}`;
      }

      return `${relative}${suffix}`;
    };

    return content
      .replace(/\b(href|src)="(\/[^"]*)"/g, (_full, attr, url) => `${attr}="${toRelative(url)}"`)
      .replace(/\bsrcset="([^"]*)"/g, (_full, value) => {
        const rewritten = value
          .split(",")
          .map((candidate) => {
            const trimmed = candidate.trim();
            const [url, ...descriptor] = trimmed.split(/\s+/);
            return [toRelative(url), ...descriptor].join(" ");
          })
          .join(", ");
        return `srcset="${rewritten}"`;
      });
  });

  return {
    dir: {
      input: "src",
      includes: "_includes",
      data: "_data",
      output: "_site",
    },
    htmlTemplateEngine: "njk",
    markdownTemplateEngine: "njk",
  };
}
