# LifeWatch Slovenia static site

Eleventy migration of `https://lifewatch.si/`, rebuilt as a lean static site and seeded from the archived WordPress install in `/app/tmp/lifewatch.si` plus the public WordPress REST API.

## Commands

```bash
npm install
npm run migrate
npm run build
npm start
```

The generated site is written to `_site/`.

## Migration notes

- WordPress core, plugin assets, Elementor runtime CSS, and cache output are intentionally not copied.
- `scripts/migrate-wordpress.js` refreshes news posts from the live WordPress API and copies referenced uploads into `src/assets/uploads`.
- The homepage is rebuilt as structured Eleventy data/templates to preserve the original layout without Elementor markup.
- Forms and WordPress comments were not migrated because static hosting needs a separate form/comment service.
