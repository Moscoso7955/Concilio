/* ============================================================
   Public page renderer.
   Fetches the single settings row from Supabase and applies it
   to the page (text, images, colors, SEO). If Supabase is not
   configured or unreachable, the static HTML defaults remain.
   ============================================================ */
(function () {
  "use strict";

  function hexToRgb(hex) {
    var h = (hex || "").replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) return { r: 15, g: 23, b: 42 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function setText(sel, val) {
    var el = document.querySelector(sel);
    if (el && val != null && val !== "") el.textContent = val;
  }

  function setMetaName(name, val) {
    if (val == null) return;
    var el = document.querySelector('meta[name="' + name + '"]');
    if (el) el.setAttribute("content", val);
  }

  function setMetaProp(prop, val) {
    if (val == null) return;
    var el = document.querySelector('meta[property="' + prop + '"]');
    if (el) el.setAttribute("content", val);
  }

  function applySettings(c) {
    if (!c) return;

    // --- Text copy ---
    setText(".coming-soon__brand", c.brand);
    setText(".coming-soon__tagline", c.tagline);
    setText(".coming-soon__footer", c.footer);

    // --- Logo ---
    var logo = document.querySelector(".coming-soon__logo");
    if (logo) {
      if (c.showLogo === false) {
        logo.style.display = "none";
      } else {
        logo.style.display = "";
        if (c.logoUrl) logo.src = c.logoUrl;
      }
    }

    // --- Background (solid color and/or image) ---
    var bg = document.querySelector(".coming-soon__bg");
    if (bg) {
      if (c.bgColor) bg.style.backgroundColor = c.bgColor;
      if (c.bgUrl) bg.style.backgroundImage = "url('" + c.bgUrl + "')";
    }

    // --- Colors ---
    var root = document.querySelector(".coming-soon");
    if (root && c.textColor) root.style.setProperty("--text", c.textColor);
    if (bg) {
      var oc = hexToRgb(c.overlayColor || "#0f172a");
      var op = c.overlayOpacity != null ? c.overlayOpacity : 0.6;
      bg.style.setProperty("--overlay", "rgba(" + oc.r + "," + oc.g + "," + oc.b + "," + op + ")");
    }
    if (c.themeColor) setMetaName("theme-color", c.themeColor);

    // --- SEO / link preview (updates browser DOM; crawlers see static defaults) ---
    if (c.seoTitle) {
      document.title = c.seoTitle;
      setMetaProp("og:title", c.seoTitle);
      setMetaName("twitter:title", c.seoTitle);
    }
    if (c.seoDescription) {
      setMetaName("description", c.seoDescription);
      setMetaProp("og:description", c.seoDescription);
      setMetaName("twitter:description", c.seoDescription);
    }
    if (c.ogImageUrl) {
      setMetaProp("og:image", c.ogImageUrl);
      setMetaName("twitter:image", c.ogImageUrl);
    }
  }

  function load() {
    var cfg = window.CONCILIO_CONFIG;
    if (!cfg || !cfg.SUPABASE_URL || cfg.SUPABASE_URL.indexOf("__") === 0) {
      return; // not configured yet — keep static defaults
    }
    var url = cfg.SUPABASE_URL + "/rest/v1/" + cfg.TABLE + "?id=eq.1&select=content";
    fetch(url, {
      headers: {
        apikey: cfg.SUPABASE_ANON_KEY,
        Authorization: "Bearer " + cfg.SUPABASE_ANON_KEY
      }
    })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (rows) {
        if (rows && rows.length && rows[0].content) applySettings(rows[0].content);
      })
      .catch(function () { /* keep static defaults */ });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", load);
  } else {
    load();
  }
})();
