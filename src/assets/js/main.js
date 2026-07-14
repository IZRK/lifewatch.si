const toggle = document.querySelector(".menu-toggle");
const nav = document.querySelector("#site-nav");

if (toggle && nav) {
  const closeMenu = () => {
    toggle.setAttribute("aria-expanded", "false");
    nav.classList.remove("is-open");
  };

  toggle.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!expanded));
    nav.classList.toggle("is-open", !expanded);
  });

  nav.addEventListener("click", (event) => {
    if (event.target.closest("a")) closeMenu();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
      closeMenu();
      toggle.focus();
    }
  });

  window.addEventListener("resize", () => {
    if (window.matchMedia("(min-width: 1025px)").matches) closeMenu();
  });
}

document.querySelectorAll(".side-submenu-toggle").forEach((button) => {
  button.addEventListener("click", () => {
    const expanded = button.getAttribute("aria-expanded") === "true";
    const item = button.closest(".side-menu-item");
    const icon = button.querySelector(".side-submenu-toggle-icon");

    button.setAttribute("aria-expanded", String(!expanded));
    item?.classList.toggle("is-open", !expanded);
    if (icon) icon.textContent = expanded ? "+" : "-";
  });
});

document.documentElement.classList.add("js-ready");

const resourceCounts = [...document.querySelectorAll(".resource-count[data-resource-type]")];

if (resourceCounts.length) {
  const endpoint = "https://metadata.izrk.zrc-sazu.si/srv/api/search/records/_search";
  const fallbacks = new Map(resourceCounts.map((element) => [
    element.dataset.resourceType,
    Number(element.textContent) || 0,
  ]));

  const fetchCounts = async () => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        size: 0,
        track_total_hits: true,
        query: {
          bool: {
            must: [
              {
                query_string: {
                  query: '(cat:"RI-SI-LifeWatch" OR cat:"lifewatch")',
                  default_operator: "AND",
                },
              },
              { terms: { isTemplate: ["n"] } },
            ],
          },
        },
        aggs: {
          resourceTypes: {
            terms: { field: "resourceType", size: 100 },
          },
        },
      }),
    });

    if (!response.ok) throw new Error(`GeoNetwork returned ${response.status}`);

    const data = await response.json();
    return new Map(
      (data.aggregations?.resourceTypes?.buckets || []).map((bucket) => [
        bucket.key,
        bucket.doc_count,
      ]),
    );
  };

  const animateCount = (element, target) => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      element.textContent = target.toLocaleString("en-GB");
      return;
    }

    const duration = 1600;
    const startedAt = performance.now();
    const frame = (now) => {
      const progress = Math.min((now - startedAt) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 4);
      element.textContent = Math.round(target * eased).toLocaleString("en-GB");
      if (progress < 1) requestAnimationFrame(frame);
    };

    element.textContent = "0";
    requestAnimationFrame(frame);
  };

  let started = false;
  const startCounters = async () => {
    if (started) return;
    started = true;

    let counts = fallbacks;
    try {
      counts = await fetchCounts();
    } catch {
      // The rendered fallback remains current when the metadata service is unavailable.
    }

    resourceCounts.forEach((element) => {
      const type = element.dataset.resourceType;
      animateCount(element, counts.get(type) ?? fallbacks.get(type) ?? 0);
    });
  };

  const resources = document.querySelector(".resources");
  if (resources && "IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        startCounters();
      }
    }, { rootMargin: "120px" });
    observer.observe(resources);
  } else {
    startCounters();
  }
}
