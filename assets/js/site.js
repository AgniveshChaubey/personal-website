// Small enhancements: light/dark toggle, Copy buttons on code, and the
// "On this page" highlight on long posts. The site works without this file.
(function () {
  "use strict";

  var root = document.documentElement;

  // Light/dark toggle -------------------------------------------------------
  // The saved choice is applied in <head> (see layouts/_partials/head.html).
  var toggle = document.querySelector(".theme-toggle");
  var darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function currentTheme() {
    var chosen = root.getAttribute("data-theme");
    if (chosen === "light" || chosen === "dark") return chosen;
    return darkQuery && darkQuery.matches ? "dark" : "light";
  }

  function labelToggle() {
    var label = currentTheme() === "dark" ? "Switch to light theme" : "Switch to dark theme";
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("title", label);
  }

  if (toggle) {
    labelToggle();
    toggle.addEventListener("click", function () {
      var next = currentTheme() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("theme", next); } catch (e) { /* private mode: still switches for this page */ }
      labelToggle();
    });
    if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener("change", labelToggle);
  }

  // Copy buttons on code blocks ----------------------------------------------
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    // Fallback for plain-http previews and older browsers.
    return new Promise(function (resolve, reject) {
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(area);
      if (ok) { resolve(); } else { reject(new Error("copy failed")); }
    });
  }

  document.querySelectorAll(".code-block").forEach(function (block) {
    var button = block.querySelector(".code-copy");
    var code = block.querySelector("pre code") || block.querySelector("pre");
    if (!button || !code) return;
    button.hidden = false;
    var timer;
    button.addEventListener("click", function () {
      copyText(code.innerText.replace(/\n$/, "")).then(
        function () { button.textContent = "Copied"; },
        function () { button.textContent = "Couldn't copy"; }
      );
      clearTimeout(timer);
      timer = setTimeout(function () { button.textContent = "Copy"; }, 1600);
    });
  });

  // "On this page": mark the section being read -------------------------------
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll(".toc a[href^='#']"));
  if (!tocLinks.length) return;

  var seen = {};
  var headings = [];
  tocLinks.forEach(function (link) {
    var id = decodeURIComponent(link.getAttribute("href").slice(1));
    if (seen[id]) return;
    seen[id] = true;
    var el = document.getElementById(id);
    if (el) headings.push({ id: id, el: el });
  });

  var ticking = false;
  function markCurrent() {
    ticking = false;
    var current = null;
    for (var i = 0; i < headings.length; i++) {
      if (headings[i].el.getBoundingClientRect().top <= 120) {
        current = headings[i].id;
      } else {
        break;
      }
    }
    tocLinks.forEach(function (link) {
      var id = decodeURIComponent(link.getAttribute("href").slice(1));
      if (id === current) {
        link.setAttribute("aria-current", "location");
      } else {
        link.removeAttribute("aria-current");
      }
    });
  }

  window.addEventListener("scroll", function () {
    if (!ticking) {
      ticking = true;
      window.requestAnimationFrame(markCurrent);
    }
  }, { passive: true });
  markCurrent();

  // Close the small-screen list after a jump, so the section is in view.
  document.querySelectorAll(".toc-inline a").forEach(function (link) {
    link.addEventListener("click", function () {
      var details = link.closest("details");
      if (details) details.open = false;
    });
  });
})();
