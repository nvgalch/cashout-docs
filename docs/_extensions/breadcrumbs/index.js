"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
exports.Extension = void 0;

const { ok } = require("node:assert");
const path = require("node:path");
const { getBuildHooks, getEntryHooks } = require("@diplodoc/cli");

class Extension {
  apply(program) {
    getBuildHooks(program)
      .BeforeRun.for("html")
      .tap("Breadcrumbs", (run) => {
        if (!program.config.breadcrumbs) return;

        // Нормализация и валидация конфига
        const raw = program.config.breadcrumbs;
        ok(raw === true || typeof raw === "object", "breadcrumbs must be object or true");

        const options = Object.assign(
          { tocAsRoot: true, appendLabeled: false },
          raw === true ? {} : raw,
        );

        ok(typeof options.tocAsRoot === "boolean", "breadcrumbs.tocAsRoot must be boolean type");
        ok(typeof options.appendLabeled === "boolean", "breadcrumbs.appendLabeled must be boolean type");

        program.config.breadcrumbs = options;

        const tocService = run.toc;
        const breadcrumbCacheMap = new Map();

        getEntryHooks(run.entry).State.tap("Breadcrumbs", (state) => {
          // Важно: state.router.pathname обычно без расширения (ru/index),
          // а tocService.for ожидает существующую ноду графа (часто ru/index.yaml или ru/page.md).
          // Поэтому резолвим toc по нескольким кандидатам.
          const toc = resolveToc(tocService, state.router.pathname);
          if (!toc?.items || toc.items.length === 0) return state;

          const breadcrumbsMap = getBreadcrumbsMap(toc, options, breadcrumbCacheMap);

          // максимально близко к исходнику
          const rootPath = path.join(state.router.pathname, state.router.base);
          const pathname = state.router.pathname.replace(rootPath, "");

          if (!breadcrumbsMap.has(pathname)) return state;

          state.data.breadcrumbs = breadcrumbsMap.get(pathname).map((item) => {
            if (!item.url || isExternalHref(item.url)) {
              return item;
            }

            // Сценарий 2: чистим расширения прямо перед добавлением .html
            const joined = path.join(rootPath, item.url);

            // 1) убираем .yaml/.yml/.md если они вдруг просочились
            // 2) убираем .html если он уже есть
            // 3) добавляем ровно один .html
            const cleaned = joined
              .replace(/\.(ya?ml|md)(?=\.html$|$)/gi, "")
              .replace(/\.html$/i, "");

            return { ...item, url: cleaned + ".html" };
          });

          return state;
        });
      });
  }
}
exports.Extension = Extension;

// ---- helpers ----

function resolveToc(tocService, pathname) {
  const normalized = String(pathname || "").replace(/^\//, "");

  const candidates = [
    normalized,
    `${normalized}.yaml`,
    `${normalized}.yml`,
    `${normalized}.md`,
    // иногда entry может быть index.* внутри директории
    path.posix.join(normalized, "index.yaml"),
    path.posix.join(normalized, "index.yml"),
    path.posix.join(normalized, "index.md"),
  ];

  for (const c of candidates) {
    try {
      return tocService.for(c);
    } catch (e) {
      // игнорируем "Node does not exist" и пробуем следующий кандидат
    }
  }

  // Если ничего не подошло — пусть упадёт с исходной ошибкой (так проще дебажить)
  return tocService.for(normalized);
}

function isExternalHref(href) {
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(href) || href.startsWith("//");
}

function setExt(href, ext) {
  const m = href.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  const base = m?.[1] ?? href;
  const query = m?.[2] ?? "";
  const hash = m?.[3] ?? "";

  const withoutExt = base.replace(/\.[^/.]+$/, "");
  return `${withoutExt}${ext}${query}${hash}`;
}

// ---- original logic ----

function getBreadcrumbsMap(toc, config, breadcrumbCacheMap) {
  if (!breadcrumbCacheMap.has(toc.path)) {
    breadcrumbCacheMap.set(toc.path, createBreadcrumbsMap(toc, config));
  }
  return breadcrumbCacheMap.get(toc.path);
}

function createBreadcrumbsMap(toc, options) {
  const breadcrumbsMap = new Map();

  function processItem(item, currentPath) {
    const breadcrumbItem = { name: item.name };

    if (item.href) {
      // оставляем как было: здесь может получиться "index.yaml",
      // но на этапе формирования конечного URL мы это вычистим (сценарий 2)
      breadcrumbItem.url = setExt(item.href, "");
    }

    if (breadcrumbItem.url) {
      breadcrumbsMap.set(breadcrumbItem.url, [...currentPath, breadcrumbItem]);
    }

    if (item.items?.length > 0) {
      const breadcrumbItems =
        !options.appendLabeled && item.labeled && !breadcrumbItem.url
          ? [...currentPath]
          : [...currentPath, breadcrumbItem];

      item.items.forEach((child) => processItem(child, breadcrumbItems));
    }
  }

  const initialBreadcrumbItems =
    options.tocAsRoot && toc.title && toc.href ? [{ name: toc.title, url: toc.href }] : [];

  toc.items.forEach((item) => processItem(item, initialBreadcrumbItems));
  return breadcrumbsMap;
}