import fs from "node:fs";

const posts = JSON.parse(
  fs.readFileSync(new URL("./posts.json", import.meta.url), "utf8")
);

const projectSlugs = ["ri-si-lifewatch", "envri-fair", "open-earth-monitor"];

const staticRedirects = [
  { from: "/home-english/", to: "/" },
  { from: "/contatti/", to: "/contacts/" },
  { from: "/communications/", to: "/communications/news/" },
  { from: "/news/", to: "/communications/news/" },
  { from: "/category/news/", to: "/communications/news/" },
  { from: "/author/lifewatch/", to: "/communications/news/" },
  { from: "/communications/eventi-it/", to: "/communications/news/" },
  { from: "/notizie/", to: "/communications/news/" },
  { from: "/partners/", to: "/consortium/" },
  { from: "/related-projects/", to: "/projects/" },
  { from: "/related-projects-categories/ongoing-projects/", to: "/projects/" },
  { from: "/en/related-projects/", to: "/projects/" },
  {
    from: "/proteuswatch-vlab/",
    to: "https://metadata.izrk.zrc-sazu.si/srv/api/records/361df301-8a0e-4d57-af74-04c41a5b0fcc"
  }
];

export default [
  ...staticRedirects,
  ...posts.map(({ slug }) => ({ from: `/news/${slug}/`, to: `/${slug}/` })),
  ...projectSlugs.map((slug) => ({
    from: `/projects/${slug}/`,
    to: `/related-projects/${slug}/`
  }))
];
