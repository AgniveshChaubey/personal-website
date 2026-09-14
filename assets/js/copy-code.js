// Adds a "Copy" button to every code block in a post.
(function () {
  "use strict";

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

  document.querySelectorAll(".prose pre").forEach(function (pre) {
    // Chroma wraps highlighted blocks in div.highlight; plain blocks get a wrapper here.
    var box = pre.closest(".highlight");
    if (!box) {
      box = document.createElement("div");
      box.className = "highlight";
      pre.parentNode.insertBefore(box, pre);
      box.appendChild(pre);
    }

    var button = document.createElement("button");
    button.type = "button";
    button.className = "code-copy";
    button.textContent = "Copy";
    button.setAttribute("aria-label", "Copy code to clipboard");

    var timer;
    button.addEventListener("click", function () {
      var code = pre.querySelector("code") || pre;
      copyText(code.innerText.replace(/\n$/, "")).then(
        function () { button.textContent = "Copied"; },
        function () { button.textContent = "Couldn't copy"; }
      );
      clearTimeout(timer);
      timer = setTimeout(function () { button.textContent = "Copy"; }, 1600);
    });

    box.appendChild(button);
  });
})();
