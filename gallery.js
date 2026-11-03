/* ============================================
   BOTTOR LEARNING FOUNDATION — Community Photo Gallery
   ============================================
   Opens gallery photos (events.html#community-gallery) in a
   full-size viewer. Arrow keys / buttons move between photos;
   Esc or the close button returns focus to the photo you opened.
   ============================================ */

(function () {
  var lightbox = document.getElementById("gallery-lightbox");
  if (!lightbox || typeof lightbox.showModal !== "function") return;

  var buttons = Array.prototype.slice.call(document.querySelectorAll(".gallery-open"));
  var img = document.getElementById("lightbox-img");
  var caption = document.getElementById("lightbox-caption");
  var current = 0;
  var opener = null;

  function groupTitle(button) {
    var grid = button.closest(".gallery-grid");
    var title = grid && grid.previousElementSibling;
    return title && title.classList.contains("gallery-group-title") ? title.textContent : "";
  }

  function show(index) {
    current = (index + buttons.length) % buttons.length;
    var button = buttons[current];
    var thumb = button.querySelector("img");
    img.src = button.getAttribute("data-full");
    img.alt = thumb.alt;
    caption.textContent = thumb.alt + (groupTitle(button) ? " — " + groupTitle(button) : "") +
      " (" + (current + 1) + " of " + buttons.length + ")";
  }

  function close() {
    lightbox.close();
  }

  buttons.forEach(function (button, index) {
    button.addEventListener("click", function () {
      opener = button;
      show(index);
      lightbox.showModal();
    });
  });

  lightbox.querySelector(".lightbox-prev").addEventListener("click", function () { show(current - 1); });
  lightbox.querySelector(".lightbox-next").addEventListener("click", function () { show(current + 1); });
  lightbox.querySelector(".lightbox-close").addEventListener("click", close);

  lightbox.addEventListener("keydown", function (e) {
    if (e.key === "ArrowLeft") show(current - 1);
    if (e.key === "ArrowRight") show(current + 1);
  });

  // Clicking the dark backdrop (outside the photo) closes the viewer.
  lightbox.addEventListener("click", function (e) {
    if (e.target === lightbox) close();
  });

  lightbox.addEventListener("close", function () {
    img.removeAttribute("src");
    if (opener) opener.focus();
  });
})();
